"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { ResumeDrop } from "@/components/ResumeDrop";
import { Button, Field, Input, Textarea, inputClass } from "@/components/ui";
import { ApiError, api, type BulkResult, type Role } from "@/lib/api";

/**
 * Inviting one candidate, or thirty.
 *
 * The single tab is for the candidate you already care about: résumé in, link
 * out. The list tab is for the shortlist that arrives as a column of email
 * addresses, which is the shape recruiting actually comes in.
 */

type Tab = "one" | "many";

export function InviteDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>("one");
  const [roles, setRoles] = useState<Role[]>([]);
  const [rubric, setRubric] = useState("backend_intern");

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      api.roles().then(setRoles).catch(() => {});
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  const close = () => {
    setTab("one");
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      onClose={close}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      className="m-auto w-[520px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-0 text-fg shadow-lg backdrop:bg-fg/30"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex gap-1 rounded-md border border-border bg-surface-2 p-0.5">
          {(
            [
              ["one", "One candidate"],
              ["many", "A list"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`h-7 rounded-[5px] px-2.5 text-[12px] font-medium transition-colors ${
                tab === key ? "bg-surface text-fg shadow-sm" : "text-fg-2 hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={close}>
          Close
        </Button>
      </div>

      <RolePicker roles={roles} rubric={rubric} onChange={setRubric} />

      {tab === "one" ? (
        <SingleInvite rubric={rubric} onCreated={onCreated} onClose={close} />
      ) : (
        <BulkInvite rubric={rubric} onCreated={onCreated} onClose={close} />
      )}
    </dialog>
  );
}

function RolePicker({
  roles,
  rubric,
  onChange,
}: {
  roles: Role[];
  rubric: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="border-b border-border px-5 py-3">
      <Field label="Role" htmlFor="invite-role">
        <select
          id="invite-role"
          value={rubric}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        >
          {roles.length === 0 && <option value="backend_intern">Backend engineering intern</option>}
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.title}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function SingleInvite({
  rubric,
  onCreated,
  onClose,
}: {
  rubric: string;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [resume, setResume] = useState("");
  const [pasting, setPasting] = useState(false);
  const [link, setLink] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [mailed, setMailed] = useState("");
  const [mailing, setMailing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (link && linkInput.current) {
      linkInput.current.focus();
      linkInput.current.select();
    }
  }, [link]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) {
      setError("Enter the candidate's email");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.invite({
        candidateEmail: email.trim(),
        candidateName: name.trim(),
        rubric,
        resumeText: resume.trim(),
      });
      setLink(`${window.location.origin}/interview/${result.inviteToken}`);
      setSessionId(result.sessionId);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the invite.");
    } finally {
      setBusy(false);
    }
  }

  async function emailIt() {
    setMailing(true);
    setError("");
    try {
      const sent = await api.emailInvite(sessionId);
      setMailed(sent.sent);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send the email.");
    } finally {
      setMailing(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard?.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      linkInput.current?.select();
    }
  }

  if (link) {
    return (
      <div className="p-5">
        <h2 className="display text-[19px]">Invite ready</h2>
        <p className="mt-1 text-[13px] text-fg-2">
          {mailed
            ? `Sent to ${mailed}. Opening it signs them straight into their interview.`
            : `Email it to ${email}, or send the link yourself.`}
        </p>
        <div className="mt-4 flex gap-2">
          <input
            ref={linkInput}
            readOnly
            value={link}
            aria-label="Invite link"
            className={`${inputClass} font-mono text-[12px]`}
          />
          <Button onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-[12px] text-bad">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between gap-2">
          <a href={link} target="_blank" rel="noreferrer">
            <Button variant="ghost">Preview as candidate</Button>
          </a>
          <div className="flex gap-2">
            {!mailed && (
              <Button onClick={emailIt} loading={mailing}>
                Email it to them
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="p-5">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Candidate email" htmlFor="invite-email">
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError("");
              }}
              placeholder="candidate@college.edu"
              autoFocus
            />
          </Field>
          <Field label="Name" htmlFor="invite-name" hint="Filled in from the résumé if blank.">
            <Input
              id="invite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Aditya Rao"
              maxLength={80}
            />
          </Field>
        </div>

        <div>
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.07em] text-fg-3">Résumé</span>
          {pasting ? (
            <>
              <Textarea
                value={resume}
                onChange={(e) => setResume(e.target.value)}
                placeholder="Paste the résumé text."
                maxLength={20000}
                autoFocus
              />
              <button
                type="button"
                onClick={() => {
                  setPasting(false);
                  setResume("");
                }}
                className="mt-1.5 text-[12px] text-accent hover:underline"
              >
                Upload a file instead
              </button>
            </>
          ) : (
            <ResumeDrop
              text={resume}
              onText={setResume}
              onName={(n) => setName((v) => v || n)}
              onPaste={() => setPasting(true)}
            />
          )}
          <p className="mt-1.5 text-[12px] text-fg-3">
            Optional. Used to pick the first question and to check answers against.
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-[12px] text-bad">
          {error}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Create link
        </Button>
      </div>
    </form>
  );
}

/** Split a pasted block into addresses. Handles a column from a spreadsheet, a
 *  comma-separated line, and "Name <email>" out of a mail client. */
function parseEmails(raw: string): { email: string; name: string }[] {
  const out: { email: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/[\n,;]+/)) {
    const text = line.trim();
    if (!text) continue;
    const angled = text.match(/^(.*?)<([^>]+)>$/);
    const email = (angled ? angled[2] : text).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: angled ? angled[1].trim().replace(/^"|"$/g, "") : "" });
  }
  return out;
}

function BulkInvite({
  rubric,
  onCreated,
  onClose,
}: {
  rubric: string;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const parsed = parseEmails(raw);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!parsed.length) {
      setError("No email addresses found in that.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setResult(
        await api.inviteMany(
          parsed.map((p) => ({ candidateEmail: p.email, candidateName: p.name, rubric })),
        ),
      );
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the invites.");
    } finally {
      setBusy(false);
    }
  }

  async function copyAll() {
    if (!result) return;
    const lines = result.created.map(
      (c) => `${c.candidateEmail}\t${window.location.origin}/interview/${c.inviteToken}`,
    );
    await navigator.clipboard?.writeText(lines.join("\n")).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (result) {
    return (
      <div className="p-5">
        <h2 className="text-[15px] font-semibold">
          {result.created.length} invite{result.created.length === 1 ? "" : "s"} ready
        </h2>
        <p className="mt-1 text-[13px] text-fg-2">
          Copy them as two columns — email and link — to paste straight into a mail merge or a
          spreadsheet.
        </p>

        <div className="mt-3 max-h-56 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-[12px]">
            <tbody>
              {result.created.map((c) => (
                <tr key={c.sessionId} className="border-b border-border last:border-b-0">
                  <td className="px-2 py-1.5 text-fg">{c.candidateEmail}</td>
                  <td className="truncate px-2 py-1.5 font-mono text-fg-3">
                    /interview/{c.inviteToken.slice(0, 14)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {result.failed.length > 0 && (
          <div className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-[12px] text-warn-fg">
            <div className="font-medium">{result.failed.length} could not be created</div>
            {result.failed.map((f) => (
              <div key={f.candidateEmail}>
                {f.candidateEmail} — {f.reason}
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={copyAll}>{copied ? "Copied" : "Copy all links"}</Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="p-5">
      <Field
        label="Email addresses"
        htmlFor="bulk-emails"
        hint="One per line, or comma separated. A column pasted from a spreadsheet works."
      >
        <Textarea
          id="bulk-emails"
          className="min-h-[150px] font-mono text-[12px]"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setError("");
          }}
          placeholder={"aditya@college.edu\npriya@college.edu\nRahul Menon <rahul@college.edu>"}
          autoFocus
        />
      </Field>

      <p className="mt-2 text-[12px] text-fg-3">
        {parsed.length > 0
          ? `${parsed.length} address${parsed.length === 1 ? "" : "es"} found. Résumés can be added per candidate afterwards.`
          : "Résumés can be added per candidate afterwards."}
      </p>

      {error && (
        <p role="alert" className="mt-3 text-[12px] text-bad">
          {error}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!parsed.length}>
          Create {parsed.length || ""} link{parsed.length === 1 ? "" : "s"}
        </Button>
      </div>
    </form>
  );
}
