import { describe, it, expect } from "vitest";
import type { EscrowCondition, EvidenceClaim, TrustTier } from "@opportunity-os/contracts";
import { evaluateCondition } from "./evaluate";

function claim(predicateType: EvidenceClaim["predicateType"], payload: Record<string, unknown>, trustTier: TrustTier = "basic"): EvidenceClaim {
  return {
    verifier: "test",
    trustTier,
    predicateType,
    payload,
    contentHash: predicateType.padEnd(64, "0"),
    sourceUri: null,
    capturedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("evaluateCondition predicates", () => {
  it("shipment_delivered requires delivered + optional tracking match", () => {
    const cond: EscrowCondition = { predicate: { type: "shipment_delivered", trackingRef: "T1" } };
    expect(evaluateCondition(cond, [claim("shipment_delivered", { delivered: true, trackingRef: "T1" })]).satisfied).toBe(true);
    expect(evaluateCondition(cond, [claim("shipment_delivered", { delivered: true, trackingRef: "T2" })]).satisfied).toBe(false);
    expect(evaluateCondition(cond, [claim("shipment_delivered", { delivered: false, trackingRef: "T1" })]).satisfied).toBe(false);
  });

  it("gps_within_geofence uses haversine distance", () => {
    const cond: EscrowCondition = { predicate: { type: "gps_within_geofence", lat: 40.0, lon: -74.0, radiusMeters: 500 } };
    expect(evaluateCondition(cond, [claim("gps_within_geofence", { lat: 40.001, lon: -74.0 })]).satisfied).toBe(true);
    expect(evaluateCondition(cond, [claim("gps_within_geofence", { lat: 40.1, lon: -74.0 })]).satisfied).toBe(false);
  });

  it("sensor_threshold compares by op", () => {
    const cond: EscrowCondition = { predicate: { type: "sensor_threshold", metric: "temp_c", op: "lte", value: 8 } };
    expect(evaluateCondition(cond, [claim("sensor_threshold", { metric: "temp_c", value: 5 })]).satisfied).toBe(true);
    expect(evaluateCondition(cond, [claim("sensor_threshold", { metric: "temp_c", value: 9 })]).satisfied).toBe(false);
  });

  it("time_elapsed is satisfied by the clock, not evidence", () => {
    const cond: EscrowCondition = { predicate: { type: "time_elapsed", afterIso: "2026-09-01T00:00:00.000Z" } };
    expect(evaluateCondition(cond, [], new Date("2026-09-02T00:00:00Z")).satisfied).toBe(true);
    expect(evaluateCondition(cond, [], new Date("2026-08-31T00:00:00Z")).satisfied).toBe(false);
  });

  it("enforces the minimum trust tier", () => {
    const cond: EscrowCondition = { predicate: { type: "document_signed", documentId: "D1" }, minTrust: "verified" };
    const basic = claim("document_signed", { signed: true, documentId: "D1" }, "basic");
    const verified = claim("document_signed", { signed: true, documentId: "D1" }, "verified");
    expect(evaluateCondition(cond, [basic]).satisfied).toBe(false);
    expect(evaluateCondition(cond, [verified]).satisfied).toBe(true);
  });
});

describe("evaluateCondition trees", () => {
  const shipped = claim("shipment_delivered", { delivered: true });
  const signed = claim("document_signed", { signed: true, documentId: "D1" });

  it("all requires every child; missing accumulates", () => {
    const cond: EscrowCondition = {
      all: [{ predicate: { type: "shipment_delivered" } }, { predicate: { type: "document_signed", documentId: "D1" } }],
    };
    const full = evaluateCondition(cond, [shipped, signed]);
    expect(full.satisfied).toBe(true);
    expect(full.usedEvidence).toHaveLength(2);
    const partial = evaluateCondition(cond, [shipped]);
    expect(partial.satisfied).toBe(false);
    expect(partial.missing).toHaveLength(1);
    expect(partial.missing[0]!.type).toBe("document_signed");
  });

  it("any is satisfied by a single child", () => {
    const cond: EscrowCondition = {
      any: [{ predicate: { type: "shipment_delivered" } }, { predicate: { type: "document_signed", documentId: "D1" } }],
    };
    expect(evaluateCondition(cond, [signed]).satisfied).toBe(true);
    const none = evaluateCondition(cond, []);
    expect(none.satisfied).toBe(false);
    expect(none.missing).toHaveLength(2);
  });
});
