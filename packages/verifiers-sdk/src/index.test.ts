import { describe, it, expect } from "vitest";
import {
  VerifierRegistry,
  makeAttestationVerifier,
  makeSignedDocumentVerifier,
  signDocument,
} from "./index";

describe("makeAttestationVerifier", () => {
  const v = makeAttestationVerifier();
  it("attests only when payload asserts it, with a content hash", () => {
    const ok = v.verify({ predicateType: "shipment_delivered", payload: { attested: true, delivered: true } });
    expect(ok).not.toBeNull();
    expect(ok!.trustTier).toBe("basic");
    expect(ok!.contentHash).toHaveLength(64);
    expect(v.verify({ predicateType: "shipment_delivered", payload: { delivered: true } })).toBeNull();
  });
});

describe("makeSignedDocumentVerifier", () => {
  const v = makeSignedDocumentVerifier("s3cr3t");
  it("accepts a correct signature and rejects a wrong one", () => {
    const good = v.verify({ predicateType: "document_signed", payload: { documentId: "D1", signature: signDocument("s3cr3t", "D1") } });
    expect(good).not.toBeNull();
    expect(good!.trustTier).toBe("verified");
    expect(good!.payload["signed"]).toBe(true);
    expect(v.verify({ predicateType: "document_signed", payload: { documentId: "D1", signature: "nope" } })).toBeNull();
  });
});

describe("VerifierRegistry", () => {
  it("indexes verifiers by the predicates they handle", () => {
    const reg = new VerifierRegistry();
    reg.register(makeAttestationVerifier());
    reg.register(makeSignedDocumentVerifier("k"));
    expect(reg.forPredicate("document_signed").map((v) => v.id)).toEqual(["local-attestation", "local-esign"]);
    expect(reg.forPredicate("sensor_threshold").map((v) => v.id)).toEqual(["local-attestation"]);
    expect(() => reg.register(makeAttestationVerifier())).toThrow(/already registered/);
  });
});
