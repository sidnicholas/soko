import { promises as dns } from "node:dns";
import { archiveInactiveParties, listFreshnessDue, purgeParty, recordFreshnessKept } from "@opportunity-os/db";
import { checkFreshness, type FreshnessProbes } from "@opportunity-os/relationship";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("worker-lifecycle:retention");

/** DNS answers that mean the name or its mail servers are gone; anything else (timeouts, SERVFAIL) means we could not tell. */
const GONE = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

async function fetchOk(url: string): Promise<boolean | null> {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "OpportunityOS-freshness/1.0" } });
    await res.body?.cancel().catch(() => undefined);
    return res.status < 500 ? true : null;
  } catch {
    return null;
  }
}

/** Live network probes: an HTTP fetch for websites, an MX lookup for email domains. */
export const networkProbes: FreshnessProbes = {
  async websiteReachable(hostAndPath) {
    const host = hostAndPath.split("/")[0]!;
    try {
      await dns.lookup(host);
    } catch (err) {
      return GONE.has((err as NodeJS.ErrnoException).code ?? "") ? false : null;
    }
    return (await fetchOk(`https://${hostAndPath}`)) ?? (await fetchOk(`http://${hostAndPath}`));
  },
  async emailDomainAcceptsMail(domain) {
    try {
      return (await dns.resolveMx(domain)).length > 0;
    } catch (err) {
      return GONE.has((err as NodeJS.ErrnoException).code ?? "") ? false : null;
    }
  },
};

export interface RetentionSummary {
  archived: number;
  checked: number;
  kept: number;
  purged: number;
}

/**
 * Relationship retention (product owner decision 2026-10-16, ADR-041):
 * archive parties untouched for 90 days, freshness-check archived parties
 * whose check is due, and purge those whose information is positively stale.
 */
export async function retentionCycle(probes: FreshnessProbes = networkProbes, now: Date = new Date()): Promise<RetentionSummary> {
  const archived = await archiveInactiveParties(now);
  const due = await listFreshnessDue(50, now);
  let kept = 0;
  let purged = 0;
  for (const party of due) {
    const { verdict, checked } = await checkFreshness(party.channels, probes);
    if (verdict === "stale") {
      await purgeParty(party.id, "stale", { type: "system", id: null });
      purged++;
      log.info({ counterpartyId: party.id, checked: checked.length }, "relationship.purged_stale");
    } else {
      await recordFreshnessKept(party.id, verdict, now);
      kept++;
    }
  }
  const summary = { archived: archived.length, checked: due.length, kept, purged };
  log.info(summary, "relationship.retention");
  return summary;
}
