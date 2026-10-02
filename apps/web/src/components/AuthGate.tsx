"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, Card, Field, Input, Spinner, tokens, tonePalette } from "@opportunity-os/ui";
import { supabase } from "../lib/supabase";

type Mode = "sign-in" | "sign-up";

/**
 * Renders the app only for a signed-in user (§22). With no Supabase config
 * (local dev-header mode) it is a pass-through.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "signed-out" | "signed-in">(supabase ? "loading" : "signed-in");

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setState(data.session ? "signed-in" : "signed-out"));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setState(session ? "signed-in" : "signed-out"));
    return () => data.subscription.unsubscribe();
  }, []);

  if (state === "signed-in") return <>{children}</>;
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: tokens.space.lg }}>
      {state === "loading" ? <Spinner label="Loading" /> : <SignInForm />}
    </div>
  );
}

function SignInForm() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    if (mode === "sign-in") {
      const { error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err) setError(err.message);
    } else {
      const { data, error: err } = await supabase.auth.signUp({ email, password });
      if (err) setError(err.message);
      else if (!data.session) setNotice("Check your email to confirm your account, then sign in.");
    }
    setBusy(false);
  }

  return (
    <div style={{ width: "100%", maxWidth: 380 }}>
      <Card title="Opportunity OS" subtitle={mode === "sign-in" ? "Sign in to continue." : "Create your account."}>
        <form onSubmit={submit} className="oos-stack" style={{ gap: tokens.space.md }}>
          <Field label="Email" htmlFor="auth-email" required>
            <Input id="auth-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="auth-password" required>
            <Input
              id="auth-password"
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && <p role="alert" style={{ margin: 0, fontSize: tokens.fontSize.sm, color: tonePalette.danger.fg }}>{error}</p>}
          {notice && <p style={{ margin: 0, fontSize: tokens.fontSize.sm, color: tokens.color.inkMuted }}>{notice}</p>}
          <Button type="submit" variant="primary" loading={busy}>
            {mode === "sign-in" ? "Sign in" : "Create account"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}>
            {mode === "sign-in" ? "Need an account? Create one" : "Have an account? Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
