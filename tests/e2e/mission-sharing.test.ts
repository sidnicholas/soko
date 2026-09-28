import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { getDb, closeDb, createMission, shareMission, unshareMission, listAccessibleMissions, listMissionShares, missionTimeline } from "@opportunity-os/db";
import type { DemandSpecification, UserRole } from "@opportunity-os/contracts";
import { requireMissionAccess } from "../../apps/api/src/missions/mission-access";

/**
 * Phase 4 sharing — mission-level authorization on top of role permissions:
 * owner > editor > viewer via mission_shares, staff overrides (admin = owner,
 * operator/reviewer = read-only), and 404 (not 403) for no access at all.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);

const SPEC = {
  what: { description: "Need a 27-inch 4K monitor under $220." },
  budget: { maximum: { amount: 22000, currency: "USD" }, flexible: true },
  quality: { constraints: [] },
  timing: { urgency: "days" },
  payment: { acceptableMethods: ["card"] },
  fulfillment: { type: "ship" },
  flexibility: { substitutesAllowed: true, negotiableFields: ["price"], nonNegotiables: [] },
  negotiationAuthorization: { mayPrepare: true, maySend: false },
} as unknown as DemandSpecification;

async function user(tag: string): Promise<{ id: string; email: string }> {
  const email = `share-${tag}-${RUN}@t.test`;
  const row = await getDb()
    .insertInto("users")
    .values({ email, display_name: tag, role: "user" })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id, email };
}

const as = (userId: string, role: UserRole = "user") => ({ userId, role, hasApprovedActionToken: false });

describe.skipIf(!HAS_DB)("mission sharing (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("enforces owner / editor / viewer / staff access and records grants on the timeline", async () => {
    const owner = await user("owner");
    const guest = await user("guest");
    const { missionId } = await createMission({
      ownerUserId: owner.id,
      title: "Monitor",
      rawIntent: "Need a monitor",
      autonomyPolicy: "discover_only",
      demandSpec: SPEC,
      changedBy: owner.id,
    });

    await expect(requireMissionAccess(as(owner.id), missionId, "own")).resolves.toBe("owner");
    // No access at all looks like a missing mission.
    await expect(requireMissionAccess(as(guest.id), missionId, "view")).rejects.toBeInstanceOf(NotFoundException);
    await expect(requireMissionAccess(as(guest.id), "not-a-uuid", "view")).rejects.toBeInstanceOf(NotFoundException);
    expect((await listAccessibleMissions(guest.id)).some((m) => m.id === missionId)).toBe(false);

    await shareMission({ missionId, email: guest.email.toUpperCase(), role: "viewer", grantedBy: owner.id });
    await expect(requireMissionAccess(as(guest.id), missionId, "view")).resolves.toBe("viewer");
    await expect(requireMissionAccess(as(guest.id), missionId, "edit")).rejects.toBeInstanceOf(ForbiddenException);

    // Re-sharing changes the role in place rather than adding a second row.
    await shareMission({ missionId, email: guest.email, role: "editor", grantedBy: owner.id });
    expect(await listMissionShares(missionId)).toHaveLength(1);
    await expect(requireMissionAccess(as(guest.id), missionId, "edit")).resolves.toBe("editor");
    await expect(requireMissionAccess(as(guest.id), missionId, "own")).rejects.toBeInstanceOf(ForbiddenException);
    const listed = (await listAccessibleMissions(guest.id)).find((m) => m.id === missionId);
    expect(listed?.access).toBe("editor");
    expect(typeof listed?.opportunity_count).toBe("number");

    await expect(shareMission({ missionId, email: owner.email, role: "viewer", grantedBy: owner.id })).rejects.toThrow(/owner/);
    await expect(shareMission({ missionId, email: `nobody-${RUN}@t.test`, role: "viewer", grantedBy: owner.id })).rejects.toThrow(/No user/);

    // Staff overrides for a mission they were never shared.
    const stranger = randomUUID();
    await expect(requireMissionAccess(as(stranger, "operator"), missionId, "view")).resolves.toBe("viewer");
    await expect(requireMissionAccess(as(stranger, "operator"), missionId, "edit")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(requireMissionAccess(as(stranger, "admin"), missionId, "own")).resolves.toBe("owner");

    expect(await unshareMission(missionId, guest.id, owner.id)).toBe(true);
    expect(await unshareMission(missionId, guest.id, owner.id)).toBe(false);
    await expect(requireMissionAccess(as(guest.id), missionId, "view")).rejects.toBeInstanceOf(NotFoundException);

    const actions = (await missionTimeline(missionId))!.map((e) => e.action);
    expect(actions.filter((a) => a === "mission.shared")).toHaveLength(2);
    expect(actions).toContain("mission.unshared");
  });
});
