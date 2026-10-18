import { BadRequestException, Controller, Get, Inject, Injectable, Module, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { getBriefing, latestBriefing, listBriefings } from "@opportunity-os/db";
import { deliverBriefing, generateBriefing } from "@opportunity-os/briefing";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";

/** Daily brief (ADR-046): read by staff; operators can rebuild today's and email it. */
@Injectable()
export class BriefingsService {
  list() {
    return listBriefings(30);
  }

  async get(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException("date must be YYYY-MM-DD");
    const b = await getBriefing(date);
    if (!b) throw new NotFoundException(`No brief for ${date}`);
    return b;
  }

  async latest() {
    return (await latestBriefing()) ?? null;
  }

  async generate(email: boolean) {
    const row = (await generateBriefing({ replace: true }))!;
    const emailed = email ? await deliverBriefing(row) : false;
    return { ...row, emailed };
  }
}

@ApiTags("briefings")
@Controller("briefings")
export class BriefingsController {
  constructor(@Inject(BriefingsService) private readonly briefings: BriefingsService) {}

  @Get()
  @ApiOperation({ summary: "Recent daily briefs (date, headline, delivered)" })
  list(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    return this.briefings.list();
  }

  @Get("latest")
  @ApiOperation({ summary: "The most recent daily brief, or null" })
  latest(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    return this.briefings.latest();
  }

  @Post("generate")
  @ApiOperation({ summary: "Rebuild today's brief from the last 24 hours (email=true also emails it)" })
  generate(@CurrentUser() user: Principal, @Query("email") email?: string) {
    requirePermission(user, "outcome:record");
    return this.briefings.generate(email === "true");
  }

  @Get(":date")
  @ApiOperation({ summary: "The brief for one local date (YYYY-MM-DD)" })
  get(@CurrentUser() user: Principal, @Param("date") date: string) {
    requirePermission(user, "opportunity:reverify");
    return this.briefings.get(date);
  }
}

@Module({ controllers: [BriefingsController], providers: [BriefingsService] })
export class BriefingsModule {}
