import { Injectable } from "@nestjs/common";
import { createMission } from "@opportunity-os/db";
import type { DemandSpecification } from "@opportunity-os/contracts";
import { parseDemand } from "@opportunity-os/demand";
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
    // §3.1(3)/§7 structure the free-text request; form fields override inferences.
    const { spec } = await parseDemand({
      text: body.description,
      hints: {
        currency: body.currency,
        budgetMaxMinor: body.budget_max,
        urgency: body.urgency,
        neededBy: body.needed_by,
      },
    });
    // Anonymous intake never authorizes outbound action until the mission is claimed.
    const demandSpec: DemandSpecification = {
      ...spec,
      negotiationAuthorization: { mayPrepare: false, maySend: false },
    };

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
