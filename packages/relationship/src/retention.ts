/**
 * Retention (product owner decision 2026-10-16, ADR-041): relationship data is
 * kept; a party untouched for 90 days is archived; archived parties are
 * freshness-checked on a schedule, and purged once their information is
 * stale. Deterministic; the network checks are injected.
 */
export const ARCHIVE_AFTER_DAYS = 90;
/** How often an archived party's information is re-checked. */
export const FRESHNESS_INTERVAL_DAYS = 30;

export function isArchiveDue(lastActivityAt: string | Date, now: Date = new Date()): boolean {
  const t = typeof lastActivityAt === "string" ? Date.parse(lastActivityAt) : lastActivityAt.getTime();
  return now.getTime() - t >= ARCHIVE_AFTER_DAYS * 86_400_000;
}

export function nextFreshnessCheck(now: Date = new Date()): string {
  return new Date(now.getTime() + FRESHNESS_INTERVAL_DAYS * 86_400_000).toISOString();
}

export interface FreshnessChannel {
  kind: string;
  normalized_value: string;
}

/** Each probe answers true (still there), false (positively gone) or null (could not tell: a timeout, a DNS server failure). */
export interface FreshnessProbes {
  /** True when the website answers (any HTTP status below 500); false when its host no longer resolves or refuses. */
  websiteReachable(hostAndPath: string): Promise<boolean | null>;
  /** True when the email domain still accepts mail (has MX records); false when it has none or does not exist. */
  emailDomainAcceptsMail(domain: string): Promise<boolean | null>;
}

export type FreshnessVerdict = "fresh" | "stale" | "unverifiable";

/**
 * Whether an archived party's information still holds. Stale only on
 * positive evidence: every checkable channel (website, email) fails. A party
 * with nothing checkable is unverifiable and is kept, never purged on a guess.
 */
export async function checkFreshness(channels: FreshnessChannel[], probes: FreshnessProbes): Promise<{ verdict: FreshnessVerdict; checked: { kind: string; value: string; ok: boolean }[] }> {
  const checked: { kind: string; value: string; ok: boolean }[] = [];
  // A probe that throws or cannot tell leaves that channel unchecked: an outage is not evidence.
  const ask = (p: Promise<boolean | null>) => p.catch(() => null);
  for (const c of channels) {
    let ok: boolean | null = null;
    if (c.kind === "website") ok = await ask(probes.websiteReachable(c.normalized_value));
    else if (c.kind === "email") {
      const domain = c.normalized_value.split("@")[1];
      if (domain) ok = await ask(probes.emailDomainAcceptsMail(domain));
    }
    if (ok !== null) checked.push({ kind: c.kind, value: c.normalized_value, ok });
  }
  if (checked.length === 0) return { verdict: "unverifiable", checked };
  return { verdict: checked.some((c) => c.ok) ? "fresh" : "stale", checked };
}
