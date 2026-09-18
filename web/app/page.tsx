"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  Field,
  Shell,
  Verdict,
  Wordmark,
  buttonClass,
  ghostButtonClass,
  inputClass,
} from "@/components/Chrome";
import { api, clearToken, mmss, readToken, saveToken, type SessionRow } from "@/lib/api";

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(readToken());
    setReady(true);
  }, []);

  if (!ready) return null;
  return token ? (
    <Dashboard
      onSignOut={() => {
        clearToken();
        setToken(null);
      }}
    />
  ) : (
    <SignIn onSignedIn={setToken} />
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .config()
      .then((config) => {
        if (config.demoPrefill) {
          setEmail(config.recruiterEmail);
          setPassword(config.recruiterPassword);
          setPrefilled(true);
        }
      })
      .catch(() => setError("Can't reach the API. Is it running on :8000?"));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token } = await api.login(email, password);
      saveToken(token);
      onSignedIn(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.15fr_1fr]">
      <section className="hidden flex-col justify-between border-r border-rule bg-sheet p-12 lg:flex">
        <Wordmark />
        <div className="max-w-md">
          <p className="font-display text-[34px] leading-[1.25] text-ink">
            It asks the follow-up question a tired interviewer forgets to ask.
          </p>
          <p className="mt-5 text-[14px] leading-relaxed text-muted">
            Every score on a screenr card points at the sentence that produced it. The
            agent gathers evidence and recommends. You decide.
          </p>
        </div>
        <p className="eyebrow">First-round screening · evidence, not verdicts</p>
      </section>

      <section className="flex items-center justify-center p-8">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="lg:hidden">
            <Wordmark />
          </div>
          <h1 className="mt-6 font-display text-[26px] text-ink lg:mt-0">Sign in</h1>
          <p className="mt-1.5 text-[13px] text-muted">
            {prefilled
              ? "Demo account, filled in for you."
              : "The single recruiter account for this deployment."}
          </p>

          <div className="mt-7 space-y-5">
            <Field label="Email">
              <input
                className={inputClass}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </Field>
            <Field label="Password">
              <input
                className={inputClass}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          </div>

          {error && <p className="mt-4 text-[13px] text-rust">{error}</p>}

          <button className={`${buttonClass} mt-6 w-full`} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>

          <p className="mt-6 text-[12px] leading-relaxed text-faint">
            Candidates never sign in. They open a link that carries a token scoped to one
            interview.
          </p>
        </form>
      </section>
    </div>
  );
}

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState("");
  const [inviting, setInviting] = useState(false);

  const load = useCallback(() => {
    api
      .sessions()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load"));
  }, []);

  useEffect(load, [load]);

  return (
    <Shell
      right={
        <button onClick={onSignOut} className="text-[13px] text-muted hover:text-ink">
          Sign out
        </button>
      }
    >
      <div className="flex items-end justify-between">
        <div>
          <p className="eyebrow">Screening queue</p>
          <h1 className="mt-2 font-display text-[30px] text-ink">Interviews</h1>
        </div>
        <button className={buttonClass} onClick={() => setInviting(true)}>
          Invite a candidate
        </button>
      </div>

      {inviting && (
        <InvitePanel
          onClose={() => setInviting(false)}
          onCreated={() => {
            setInviting(false);
            load();
          }}
        />
      )}

      {error && <p className="mt-8 text-[13px] text-rust">{error}</p>}

      {rows && rows.length === 0 && !error && (
        <div className="mt-10 border-t border-rule pt-10">
          <p className="font-display text-[20px] text-ink">No interviews yet</p>
          <p className="mt-2 max-w-md text-[14px] leading-relaxed text-muted">
            Invite a candidate and they get a link. When they finish, the scorecard lands
            here with every judgement tied to what they said.
          </p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <table className="mt-8 w-full border-collapse">
          <thead>
            <tr className="border-y border-rule">
              {["Candidate", "Role", "Length", "Overall", "Reading", ""].map((head) => (
                <th
                  key={head}
                  className="eyebrow py-2.5 text-left font-normal first:pl-0 last:text-right"
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-rule-soft hover:bg-sheet">
                <td className="py-3.5 pr-4">
                  <Link
                    href={`/sessions/${row.id}`}
                    className="text-[14px] text-ink underline-offset-4 hover:underline"
                  >
                    {row.candidate}
                  </Link>
                  {!row.reviewed && row.finished && (
                    <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-pine align-middle" />
                  )}
                </td>
                <td className="py-3.5 pr-4 text-[13px] text-muted">{row.roleTitle}</td>
                <td className="py-3.5 pr-4 font-mono text-[13px] text-muted">
                  {row.started ? mmss(row.durationSeconds) : "—"}
                </td>
                <td className="py-3.5 pr-4 font-mono text-[13px] text-ink">
                  {row.overall ?? "—"}
                </td>
                <td className="py-3.5 pr-4">
                  {row.finished ? (
                    <Verdict recommendation={row.recommendation} />
                  ) : (
                    <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-faint">
                      {row.started ? "in progress" : "not started"}
                    </span>
                  )}
                </td>
                <td className="py-3.5 text-right">
                  <Link href={`/sessions/${row.id}`} className="text-[13px] text-pine">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}

function InvitePanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [resume, setResume] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) {
      setError("Enter the candidate's email first");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.invite(email, name, resume);
      setLink(`${window.location.origin}/interview/${result.inviteToken}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the invite");
    } finally {
      setBusy(false);
    }
  }

  if (link) {
    return (
      <div className="mt-8 border border-pine bg-pine-soft/40 p-6">
        <p className="eyebrow">Invite ready</p>
        <p className="mt-2 text-[14px] text-ink">
          Send this to {email}. Opening it signs them straight into their interview — no
          account, no password.
        </p>
        <div className="mt-4 flex gap-2">
          <input readOnly value={link} className={`${inputClass} font-mono text-[12px]`} />
          <button
            className={ghostButtonClass}
            onClick={() => navigator.clipboard.writeText(link)}
          >
            Copy
          </button>
        </div>
        <div className="mt-5 flex gap-3">
          <a href={link} target="_blank" rel="noreferrer" className={buttonClass}>
            Open it yourself
          </a>
          <button className={ghostButtonClass} onClick={onCreated}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-8 border border-rule bg-sheet p-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="eyebrow">New interview</p>
          <p className="mt-2 max-w-md text-[13px] leading-relaxed text-muted">
            Paste the résumé and the agent will pull out the claims worth probing. Skip it
            and it asks what they have built instead.
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-[13px] text-muted">
          Cancel
        </button>
      </div>

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <Field label="Candidate email">
          <input
            className={inputClass}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError("");
            }}
            placeholder="candidate@college.edu"
          />
        </Field>
        <Field label="Name" hint="Optional — taken from the email if blank.">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Aditya Rao"
          />
        </Field>
      </div>

      <div className="mt-5">
        <Field label="Résumé text" hint="Optional.">
          <textarea
            className={`${inputClass} h-28 resize-y`}
            value={resume}
            onChange={(e) => setResume(e.target.value)}
            placeholder="Paste the résumé here."
          />
        </Field>
      </div>

      {error && <p className="mt-4 text-[13px] text-rust">{error}</p>}

      <button className={`${buttonClass} mt-6`} disabled={busy}>
        {busy ? "Creating…" : "Create the link"}
      </button>
    </form>
  );
}
