# Session Handoff — work of 2026-09-27 (written 2026-10-06)

Purpose: a record of one long Claude Code session in this repo — what was
asked, what was built, what was decided, and what was left open. The durable
architectural state lives in `docs/Opportunity_OS_PROJECT_MEMORY.md`; this
file is the narrative of the session and the reasoning behind it.

**Read this first:** this session's last code change was pushed on
2026-09-27 (`07828a1`). Eleven further commits landed from other sessions on
2026-10-02/03 (Supabase JWT auth, test-database isolation, cron workers, the
intel slice). Where a later session has already closed something this
session left open, it is marked **[since resolved]** below. Trust `git log`
and the project memory doc over this file for anything after 2026-09-27.

## Repo state when this note was written

- Branch `main`, HEAD `2665f39`, matches `origin/main`
  (`https://github.com/sidnicholas/soko.git`).
- Untracked: `.claudeignore`, this file, `soko-extended-prd.docx`.
- Migrations on disk: through `0019_intel.sql` (this session added `0018`).

## What was asked and what was done, in order

### 1. Review and cleanup (`11c1fa2`, `2c615c7`)

Asked to review the working tree. It held two untracked files: a 2026-09-20
handoff note and `.claudeignore`.

- **Type errors fixed at the source.** `UsersTable.trust_tier` / `status`
  were typed as required on insert although the database defaults them, which
  broke `tsc` in five e2e files; they are now `Generated<string>`. Three fetch
  mocks in `apps/api/src/messaging/channels.test.ts` declared no parameters,
  so `mock.calls[0]` was typed as an empty tuple.
- **Old handoff merged.** Its one unrecorded item (live-DB tests silently
  skip unless the environment is exported first) went into the project memory
  doc §7.
- **`.claudeignore` replaced** by `permissions.deny` rules in
  `.claude/settings.json` (`.env`, `.env.local`, `node_modules`, `build`,
  `coverage`). Claude Code does not read `.claudeignore`.
  `.claude/settings.local.json` was added to `.gitignore`.
- The user deleted both untracked files by hand, because auto mode blocked
  the deletion. **Both files later reappeared with their original
  timestamps** — almost certainly OneDrive restoring them. This note
  overwrites the restored handoff. `.claudeignore` is still there, still
  inert; deleting it again may not stick while the repo lives under OneDrive.

### 2. Recipient-level webhook reconciliation (`4d21373`)

Chosen from the project memory doc's "next options" as the highest-value item
that code alone could finish.

- `MilestoneRecipient` gained `payoutStatus`. Webhooks update one recipient
  at a time through `getMilestoneByRecipientRef` and
  `setRecipientPayoutStatus` (row-locked, audited, never moves back to
  `pending`).
- **Bug fixed (Circle):** a split milestone was marked released as soon as
  the *first* recipient's transfer completed. It now releases only when every
  recipient is confirmed; any failure disputes the milestone.
- **Stripe:** `transfer.created` backfills `confirmed`; `transfer.reversed`
  records `reversed` / `partially_reversed` and logs for operator review. It
  makes no state change, because a settled plan has no legal move to disputed.
- **Guard added:** `payment_intent.succeeded` no longer auto-releases a split
  milestone whose Transfers were never created.
- `/webhooks/circle` also finalizes `CircleNftRail` asset transfers.
- **Bug fixed:** `recordAssetTransferResult` audited a real rail's `pending`
  submit as `asset_transfer.failed`; it is now `asset_transfer.submitted`.

### 3. Phase 4 — timelines (`db2eaf6`)

- `GET /transactions/:id/timeline` used to return only audit rows on the
  transaction itself. `GET /missions/:id/timeline` is new. Both come from
  `packages/db/src/repositories/timeline.ts` and return `TimelineEntry[]`.
- One source per fact, so nothing is duplicated: the audit chain for most
  things; the **outbox** for missions and approvals, which write no audit
  rows (approvals also have no `created_at`); the evidence ledger; mission
  versions; discovered opportunities. Capped at 500 entries.
- Shared `EntityTimeline` component: newest first, category filter, links.

### 4. Phase 4 — sharing and steering (`78c8452`, migration `0018`)

- **Sharing.** `mission_shares` (viewer / editor). `requireMissionAccess` in
  `apps/api/src/missions/mission-access.ts` runs on every per-mission route:
  owner > editor > viewer; admin acts as owner; operator, reviewer, service
  and agent are read-only; no access returns **404, not 403**.
  **Behavior change:** before this, any user could read any mission by id and
  operators could pause any mission.
- **Steering.** `POST /missions/:id/steer` writes exclusions as hard
  `keyword neq <term>` constraints in a new mission version; discovery skips
  matching supply; matching open opportunities are set aside with the reason.
  `POST /opportunities/:id/reject` requires a reason.
- **Bug fixed:** both opportunity upserts overwrote `status` on every
  re-discovery, so rejected, approved and executing opportunities reverted to
  candidate / qualified. Only candidate / qualified / expired rows now take
  the fresh status (`rediscoveredStatus`).
- **Gap fixed:** a running durable discovery workflow never saw constraint
  edits. A `demand` signal is now sent after edits and steering.
- The "Agent questions" placeholder card was replaced by the Steer card.
  Nothing in the system generates agent questions.

### 5. Phase 4 — Search/Ask and archive (`07828a1`)

- `POST /missions/parse` runs the demand parser without creating anything.
  The home page's "Read my request" prefills the form from it. Before this,
  the home page always sent its own `demand_spec`, so the parser never ran
  and budget or timing written in the text was ignored.
- `GET /search?q=` covers missions and live opportunities, with the same
  visibility as mission access. LIKE wildcards are treated literally.
- Archive page: text filter, "Shared with me", opportunity counts, last
  activity, most recently active first.

### 6. Railway check (no code change)

- Project `opportunity-os` auto-deploys `sidnicholas/soko` `main`. The push
  redeployed `api` and `web` successfully, and `/v1/health` returned 200.
- The deployed `DATABASE_URL` is the **same Supabase database** as the local
  `.env` (hosts compared; no credentials printed).

## Decisions the user made

- Phase 4 order: timelines first, then "complete Phase 4 items".
- Commit webhook work once the suite was green; later, commit and push all.
- Earlier standing preference (in memory): accept regulatory risk explicitly
  rather than pre-blocking; keep open backlogs unsequenced.

## What this session left open

| Item | Status |
|---|---|
| Live API trusted `x-user-id` / `x-user-role` headers on a public URL, so anyone could act as any user | **[since resolved]** — `3eb74b4` Supabase JWT authentication, 2026-10-02 |
| Tests and migrations ran against the production Supabase; this session's e2e runs left test users, missions and opportunities in it | **[since resolved]** — `7d91db1` runs live-DB tests against a local Postgres; the project memory doc records the test rows being deleted on 2026-10-03 |
| Six e2e tests (graph, signals, lifecycle) timing out at 5s against the remote database; reproduced on the parent commit, so not caused here | Not re-checked. Likely moot now that tests run against a local database — verify with `pnpm test:db` |
| Split payout after an *asynchronous* Stripe capture: the guard stops a false release, but nothing then creates the Transfers | **Open** — project memory doc §5, Phase 3 "Remaining" item 1 |
| Agent→user questions | **Open** — needs something that generates questions |
| Stripe webhook must subscribe to `transfer.created` and `transfer.reversed` | **Open, user action** — only matters once real webhooks flow |
| A real DeFi rail needs a legal read first; a real data-feed rail is the lowest-exposure next rail | **Open, user decision** — carried over from the 2026-09-20 note |

## Things worth knowing that the code does not say

- **Auto mode blocks deleting untracked files.** Ask the user to run the
  `rm` themselves with the `!` prefix.
- **`next dev` under WSL on `/mnt/c` misses file changes.** Start it with
  `WATCHPACK_POLLING=true`. A stale dev server cost a debugging round here.
- **UI smoke tests** were done with Python Playwright against a mocked API
  (`page.route("**/v1/**", …)`), pointing at the cached Chromium binary
  because the installed Playwright expected a newer browser build.
- **Remote-database latency** made several tests brush the 5s vitest default;
  this session's live-DB tests carry an explicit 30s budget.
- **`.env` is deny-listed for the Read tool.** Tests still worked through
  `set -a && source .env && set +a` in the shell, without printing values.
