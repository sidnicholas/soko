import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Only the project origin is meaningful; supabase-js appends `/auth/v1/...`
 * itself. Dropping any path keeps a pasted endpoint URL (e.g. the Data API's
 * `.../rest/v1/`) from producing "Invalid path specified in request URL".
 */
function projectOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

const url = projectOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Supabase Auth client (§22). Null when sign-in isn't configured — the app
 * then falls back to the local dev-header identity, which the API only
 * honours with AUTH_DEV_HEADERS=true (never in production).
 */
export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null;
