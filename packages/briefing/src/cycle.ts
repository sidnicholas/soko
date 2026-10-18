import { getConfig } from "@opportunity-os/config";
import { gatherBriefData, getBriefing, markBriefingDelivered, saveBriefing, type BriefRow } from "@opportunity-os/db";
import { createLogger } from "@opportunity-os/observability";
import { outreachSettings, smtpSender, type MailSender } from "@opportunity-os/outreach";
import { newMessageId } from "@opportunity-os/relationship";
import { buildBrief, localDateHour, renderBriefText, type Brief } from "./brief";

const log = createLogger("briefing");

function settings() {
  const cfg = getConfig();
  return {
    hour: cfg.briefing.hour,
    timezone: cfg.briefing.timezone,
    emailTo: cfg.briefing.emailTo,
    webBaseUrl: cfg.auth.webOrigins[0] ?? null,
    intelBudgetUsd: cfg.intel.dailyBudgetUsd,
    apifyBudgetUsd: cfg.connectors.apify.dailyBudgetUsd,
  };
}

/** Builds and stores the brief for the 24 hours before `now`. `replace` regenerates today's. */
export async function generateBriefing(opts: { now?: Date; replace: boolean }): Promise<BriefRow | null> {
  const s = settings();
  const now = opts.now ?? new Date();
  const { date } = localDateHour(now, s.timezone);
  const start = new Date(now.getTime() - 24 * 3_600_000);
  const brief = buildBrief(await gatherBriefData(start, now), { date, timezone: s.timezone, intelBudgetUsd: s.intelBudgetUsd, apifyBudgetUsd: s.apifyBudgetUsd });
  return saveBriefing({ date, periodStart: brief.periodStart, periodEnd: brief.periodEnd, headline: brief.headline, content: brief }, { replace: opts.replace });
}

/** Emails a stored brief to the operator from the outreach mailbox; not counted against outreach caps. */
export async function deliverBriefing(row: BriefRow, sender?: MailSender): Promise<boolean> {
  const s = settings();
  const mail = outreachSettings();
  if (!s.emailTo || !mail) return false;
  try {
    await (sender ?? smtpSender(mail.mailbox, mail.fromName)).send({
      from: mail.mailbox.address,
      to: s.emailTo,
      subject: `Daily brief ${row.brief_date}: ${row.headline}`,
      text: renderBriefText(row.content as Brief, s.webBaseUrl),
      messageId: newMessageId(mail.mailbox.address),
      inReplyTo: null,
      references: [],
      headers: {},
    });
    await markBriefingDelivered(row.id, null);
    return true;
  } catch (err) {
    log.warn({ err: String(err) }, "briefing.delivery_failed");
    await markBriefingDelivered(row.id, String(err));
    return false;
  }
}

/** One sweep (worker-lifecycle): once the local hour passes BRIEF_HOUR, today's brief is built and emailed once. */
export async function briefingCycle(deps: { now?: Date; sender?: MailSender } = {}): Promise<BriefRow | null> {
  const s = settings();
  const now = deps.now ?? new Date();
  const { date, hour } = localDateHour(now, s.timezone);
  if (hour < s.hour || (await getBriefing(date))) return null;
  const row = await generateBriefing({ now, replace: false });
  if (!row) return null;
  log.info({ date, headline: row.headline }, "briefing.ready");
  await deliverBriefing(row, deps.sender);
  return row;
}
