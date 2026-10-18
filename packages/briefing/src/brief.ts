import type { BriefData } from "@opportunity-os/db";

/**
 * The daily brief (ADR-046), built from one period's facts. Pure: the same
 * data gives the same brief. Every item carries citations, links to the
 * record or source it summarizes (PRD P2 gate: briefing source citations).
 * Internal links are app paths ("/outreach/…"); external ones are full URLs.
 */

export interface BriefCitation {
  label: string;
  href: string;
}

export interface BriefItem {
  text: string;
  detail?: string;
  citations: BriefCitation[];
}

export interface BriefSection {
  key: "follow_ups" | "candidates" | "outreach" | "deals" | "sources" | "spend";
  title: string;
  summary: string;
  items: BriefItem[];
}

export interface Brief {
  date: string;
  timezone: string;
  periodStart: string;
  periodEnd: string;
  headline: string;
  sections: BriefSection[];
}

const usd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : 0, minimumFractionDigits: v > 0 && v < 10 ? 2 : 0 })}`;
const money = (minor: number | null, currency: string | null) => (minor === null ? "?" : `${currency && currency !== "USD" ? `${currency} ` : "$"}${Math.round(minor / 100).toLocaleString("en-US")}`);
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const BUCKET: Record<string, string> = { act_now: "act now", verify_next: "verify next" };

export function buildBrief(d: BriefData, o: { date: string; timezone: string; intelBudgetUsd: number; apifyBudgetUsd: number }): Brief {
  const sections: BriefSection[] = [];

  // Follow-ups first: people already in conversation are worth more than new leads.
  const f = d.followUps;
  const STAGE: Record<string, string> = { due: "due", cold: "gone cold", stalled: "stalled" };
  sections.push({
    key: "follow_ups",
    title: "Follow-ups",
    summary:
      f.due || f.cold || f.stalled
        ? [f.due ? `${plural(f.due, "follow-up")} due` : null, f.stalled ? `${f.stalled} stalled` : null, f.cold ? `${f.cold} gone cold` : null, `${f.upcoming} waiting`].filter(Boolean).join(", ") + "."
        : f.upcoming
          ? `Nothing due; ${f.upcoming} waiting.`
          : "Nothing being worked.",
    items: f.top.map((t) => ({
      text: t.title,
      detail: `${STAGE[t.stage] ?? t.stage} · ${t.action} · last touch ${t.last_touch_at.slice(0, 10)}`,
      citations: [
        { label: "Follow-ups", href: `/follow-ups#${t.id}` },
        { label: "Source", href: t.lead_url },
      ],
    })),
  });

  sections.push({
    key: "candidates",
    title: "New actionable candidates",
    summary: d.actionableCount ? `${plural(d.actionableCount, "candidate")} reached act now or verify next${d.actionableCount > d.candidates.length ? `; top ${d.candidates.length} below` : ""}.` : "No new actionable candidates.",
    items: d.candidates.map((c) => ({
      text: c.title,
      detail: `${BUCKET[c.bucket] ?? c.bucket} · score ${Math.round(c.score)} · expected $${Math.round(c.ev_low_usd).toLocaleString("en-US")}–$${Math.round(c.ev_high_usd).toLocaleString("en-US")} · ${c.confidence} confidence`,
      citations: [
        { label: "Action Queue", href: "/queue" },
        { label: c.lead_kind === "demand" ? "Buyer source" : "Supply source", href: c.lead_url },
        ...(c.counter_url ? [{ label: "Counterpart", href: c.counter_url }] : []),
      ],
    })),
  });

  const out = d.outreach;
  const outreachItems: BriefItem[] = out.needsReview.map((r) => ({
    text: `${r.classification === "opt_out" ? "Opt-out from" : "Reply from"} ${r.party_name}`,
    detail: r.subject,
    citations: [{ label: "Conversation", href: `/outreach/${r.conversation_id}` }],
  }));
  if (out.drafts) outreachItems.push({ text: `${plural(out.drafts, "draft")} waiting for your approval`, citations: [{ label: "Outreach Inbox", href: "/outreach" }] });
  if (out.exceptions) outreachItems.push({ text: `${plural(out.exceptions, "failed send")} in the last 30 days`, citations: [{ label: "Exceptions", href: "/outreach" }] });
  if (out.bounces) outreachItems.push({ text: `${plural(out.bounces, "bounce")}: those addresses are marked bounced`, citations: [{ label: "Outreach Inbox", href: "/outreach" }] });
  sections.push({
    key: "outreach",
    title: "Outreach",
    summary: `${out.sent} sent, ${plural(out.replies, "reply", "replies")}, ${plural(out.optOuts, "opt-out")}; ${out.needsReview.length ? `${out.needsReview.length} to review` : "nothing to review"}, ${out.queued} queued.`,
    items: outreachItems,
  });

  sections.push({
    key: "deals",
    title: "Good deals",
    summary: d.deals.checked ? `${plural(d.deals.checked, "listing")} priced against comparables: ${d.deals.goodDeals} good, ${plural(d.deals.leadsRaised, "lead")} raised.` : "No listings were priced.",
    items: d.deals.top.map((g) => ({
      text: g.title,
      detail: `${money(g.price_minor, g.currency)}, ${Math.round(g.discount * 100)}% under the comparables' median of ${money(g.comp_median_minor, g.currency)}${g.demand_term ? `; a buyer asked for "${g.demand_term}"` : ""}`,
      citations: [
        { label: "Listing", href: g.url },
        { label: "Source Registry", href: "/sources" },
      ],
    })),
  });

  const s = d.sources;
  const sourceItems: BriefItem[] = [
    ...s.pausedInPeriod.map((p) => ({ text: `Paused: ${p.name}`, detail: p.reason ?? undefined, citations: [{ label: "Source Registry", href: "/sources" }] })),
    ...s.failing.map((f) => ({ text: `Failing: ${f.name}`, detail: `${plural(f.consecutive_failures, "failure")} in a row`, citations: [{ label: "Source Registry", href: "/sources" }] })),
  ];
  if (s.quarantinePending) sourceItems.push({ text: `${plural(s.quarantinePending, "item")} waiting in quarantine`, citations: [{ label: "Quarantine", href: "/sources" }] });
  sections.push({
    key: "sources",
    title: "Sources",
    summary: `${s.active} active; ${plural(s.apifyRuns, "actor run")} (${s.apifyFailed} failed), ${plural(s.apifyItemsNew, "new item")}.`,
    items: sourceItems,
  });

  const total = d.spend.intelUsd + d.spend.apifyUsd;
  const spendItems: BriefItem[] = [
    { text: `Search and models: ${usd(d.spend.intelUsd)} of ${usd(o.intelBudgetUsd)} a day`, citations: [{ label: "Yield & Spend", href: "/yield" }] },
    { text: `Apify actors: ${usd(d.spend.apifyUsd)} of ${usd(o.apifyBudgetUsd)} a day`, citations: [{ label: "Source Registry", href: "/sources" }] },
  ];
  if (d.actionableCount) spendItems.push({ text: `${usd(total / d.actionableCount)} per actionable candidate`, citations: [{ label: "Yield & Spend", href: "/yield" }] });
  sections.push({ key: "spend", title: "Spend", summary: `${usd(total)} in the period.`, items: spendItems });

  const headline = [
    f.due ? plural(f.due, "follow-up") + " due" : null,
    plural(d.actionableCount, "new actionable candidate"),
    out.needsReview.length ? plural(out.needsReview.length, "reply", "replies") + " to review" : null,
    d.deals.goodDeals ? plural(d.deals.goodDeals, "good deal") : null,
    `${usd(total)} spent`,
  ]
    .filter(Boolean)
    .join(" · ");

  return { date: o.date, timezone: o.timezone, periodStart: d.periodStart, periodEnd: d.periodEnd, headline, sections };
}

/** Absolute link for email: app paths are put under the web app's address. */
export function absolute(href: string, webBaseUrl: string | null): string | null {
  if (/^https?:\/\//.test(href)) return href;
  return webBaseUrl ? `${webBaseUrl.replace(/\/+$/, "")}${href}` : null;
}

/** Plain-text email: each item with its links underneath. */
export function renderBriefText(b: Brief, webBaseUrl: string | null): string {
  const lines = [`Daily brief, ${b.date}`, b.headline, ""];
  for (const s of b.sections) {
    lines.push(s.title.toUpperCase(), s.summary);
    for (const i of s.items) {
      lines.push(`- ${i.text}${i.detail ? ` (${i.detail})` : ""}`);
      const links = i.citations.map((c) => {
        const href = absolute(c.href, webBaseUrl);
        return href ? `${c.label}: ${href}` : null;
      });
      for (const l of links) if (l) lines.push(`    ${l}`);
    }
    lines.push("");
  }
  const page = absolute(`/brief?date=${b.date}`, webBaseUrl);
  if (page) lines.push(`Open in Opportunity OS: ${page}`);
  return lines.join("\n");
}

/** The local calendar date and hour of an instant in a time zone. */
export function localDateHour(now: Date, timezone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}
