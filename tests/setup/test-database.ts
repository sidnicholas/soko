/**
 * Runs before every test file (vitest `setupFiles`), ahead of the file's own
 * top-level `HAS_DB = Boolean(process.env.DATABASE_URL)` check.
 *
 * Live-DB tests write rows, so they must never reach the app's DATABASE_URL —
 * the workspace `.env` points at the shared Supabase project the deployed app
 * reads. Tests use TEST_DATABASE_URL instead, and only a local host is
 * accepted. Without it, DATABASE_URL is blanked: live-DB suites skip, and
 * `packages/config`'s dotenv loader (which never overwrites a set variable)
 * can't fill it back in from `.env`.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres", "postgres-test"]);

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  const host = new URL(testUrl).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`TEST_DATABASE_URL must point at a local Postgres; refusing host "${host}"`);
  }
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "";
}
