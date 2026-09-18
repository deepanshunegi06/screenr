"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button, Card, Field, Input, Logo } from "@/components/ui";
import { api, saveToken } from "@/lib/api";

export function SignIn({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [demoMode, setDemoMode] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"login" | "demo" | null>(null);

  useEffect(() => {
    // A failure here must not block a normal sign-in, so it fails silent.
    api
      .config()
      .then((config) => setDemoMode(config.demoMode))
      .catch(() => {});
  }, []);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy("login");
    setError("");
    try {
      const { token } = await api.login(email.trim(), password);
      saveToken(token);
      onSignedIn(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function useDemo() {
    setBusy("demo");
    setError("");
    try {
      const { token } = await api.demo();
      saveToken(token);
      onSignedIn(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo sign-in failed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-[360px]">
        <div className="mb-5 flex justify-center">
          <Logo />
        </div>
        <Card>
          <h1 className="display text-[21px] text-fg">Sign in</h1>
          <form onSubmit={signIn} className="mt-4 space-y-4">
            <Field label="Email" htmlFor="signin-email">
              <Input
                id="signin-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </Field>
            <Field label="Password" htmlFor="signin-password">
              <Input
                id="signin-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>

            {error && (
              <p role="alert" className="text-[12px] text-bad">
                {error}
              </p>
            )}

            <Button type="submit" variant="primary" className="w-full" loading={busy === "login"} disabled={busy !== null}>
              Sign in
            </Button>
            {demoMode && (
              <Button type="button" className="w-full" loading={busy === "demo"} disabled={busy !== null} onClick={useDemo}>
                Use demo account
              </Button>
            )}
          </form>
        </Card>
        <p className="mt-4 text-center text-[12px] text-fg-3">
          Candidates don&apos;t sign in. They open the link from their invite.
        </p>
      </div>
    </main>
  );
}
