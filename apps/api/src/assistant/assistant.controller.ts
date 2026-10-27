import { Controller, Get, Inject, Module, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { getOpportunityMissionId, type ChatSubjectType } from "@opportunity-os/db";
import { CHAT_MODEL_IDS } from "@opportunity-os/llm-gateway";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import { requireMissionAccess } from "../missions/mission-access";
import { AssistantService } from "./assistant.service";

/** URL segment to subject type. */
const SUBJECTS: Record<string, ChatSubjectType> = { candidates: "intel_candidate", opportunities: "opportunity" };

const AskSchema = z.object({
  model: z.enum(CHAT_MODEL_IDS),
  content: z.string().trim().min(1).max(4000),
});

@ApiTags("assistant")
@Controller("assistant")
export class AssistantController {
  constructor(@Inject(AssistantService) private readonly assistant: AssistantService) {}

  /** Staff only (never agents: every message spends). An opportunity also follows its mission's access, like its detail page. */
  private async authorize(user: Principal, segment: string, id: string): Promise<ChatSubjectType> {
    requirePermission(user, "assistant:chat");
    const type = SUBJECTS[segment];
    if (!type) throw new NotFoundException(`Unknown subject ${segment}`);
    if (type === "opportunity") {
      const missionId = await getOpportunityMissionId(id);
      if (missionId === undefined) throw new NotFoundException(`Opportunity ${id} not found`);
      if (missionId) await requireMissionAccess(user, missionId, "view");
    }
    return type;
  }

  @Get(":subject/:id")
  @ApiOperation({ summary: "The assistant conversation on a candidate or opportunity, with the models available and today's spend (ADR-048)" })
  async thread(@CurrentUser() user: Principal, @Param("subject") subject: string, @Param("id", ParseUUIDPipe) id: string) {
    const type = await this.authorize(user, subject, id);
    return this.assistant.thread(type, id);
  }

  @Post(":subject/:id")
  @ApiOperation({ summary: "Ask the chosen model about a candidate or opportunity; returns the question and the reply (or why it failed)" })
  async ask(@CurrentUser() user: Principal, @Param("subject") subject: string, @Param("id", ParseUUIDPipe) id: string, @ZodBody(AskSchema) body: z.infer<typeof AskSchema>) {
    const type = await this.authorize(user, subject, id);
    return this.assistant.ask(type, id, body, user.userId);
  }
}

@Module({ controllers: [AssistantController], providers: [AssistantService] })
export class AssistantModule {}
