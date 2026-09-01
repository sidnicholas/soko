import { Injectable } from "@nestjs/common";
import { createMission } from "@opportunity-os/db";
import { DemandSpecification } from "@opportunity-os/contracts";
import type { PublicRequestBody } from "./public.dto";

/**
 * System owner for anonymous public intake. A users row with this id must be
 * seeded (migrations/seed); it isolates marketplace-sourced missions from
 * authenticated user missions until they are claimed (§3.1(21)).
 */
const PUBLIC_INTAKE_USER_ID = "00000000-0000-0000-0000-000000000000";

@Injectable()
export class PublicService {
  async createRequest(body: PublicRequestBody) {
    const demandSpec = DemandSpecification.parse({
      what: { description: body.description },
      budget: {
        flexible: body.budget_max === undefined,
        ...(body.budget_max !== undefined
          ? { maximum: { amount: body.budget_max, currency: body.currency ?? "USD" } }
          : {}),
      },
      quality: { constraints: [] },
      timing: {
        urgency: body.urgency ?? "flexible",
        ...(body.needed_by !== undefined ? { neededBy: body.needed_by } : {}),
      },
      payment: { acceptableMethods: ["card"] },
      fulfillment: { type: "other" },
      flexibility: { substitutesAllowed: true, negotiableFields: [], nonNegotiables: [] },
      negotiationAuthorization: { mayPrepare: false, maySend: false },
    });

    const result = await createMission({
      ownerUserId: PUBLIC_INTAKE_USER_ID,
      title: body.title ?? body.description.slice(0, 80),
      rawIntent: body.description,
      autonomyPolicy: "discover_only",
      demandSpec,
      changedBy: PUBLIC_INTAKE_USER_ID,
    });

    return { mission_id: result.missionId, version_id: result.versionId };
  }
}
