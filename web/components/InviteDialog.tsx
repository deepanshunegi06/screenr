"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button, Field, Input, Textarea, inputClass } from "@/components/ui";
import { api, ApiError, type Role } from "@/lib/api";

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
  const linkInput = useRef<HTMLInputElement>(null);

  const [roles, setRoles] = useState<Role[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [rubric, setRubric] = useState("backend_intern");
  const [resume, setResume] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

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

  useEffect(() => {
    if (link && linkInput.current) {
      linkInput.current.focus();
      linkInput.current.select();
    }
  }, [link]);

  function reset() {
    setEmail("");
    setName("");
    setResume("");
    setLink("");
    setError("");
    setCopied(false);
  }

  function close() {
    reset();
    onClose();
  }

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
        resumeText: resume,
      });
      setLink(`${window.location.origin}/interview/${result.inviteToken}`);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the invite. Try again.");
    } finally {
      setBusy(false);
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

  return (
    <dialog
      ref={dialog}
      onClose={close}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      className="m-auto w-[440px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-0 text-fg shadow-lg backdrop:bg-fg/30"
    >
      {link ? (
        <div className="p-5">
          <h2 className="text-[15px] font-semibold">Invite ready</h2>
          <p className="mt-1 text-[13px] text-fg-2">
            Send this to {email}. Opening it signs them straight into their interview.
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
          <p className="mt-3 text-[12px] text-fg-3">
            Opening the link yourself starts the interview as the candidate.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <a href={link} target="_blank" rel="noreferrer" className="inline-flex">
              <Button variant="ghost">Preview as candidate</Button>
            </a>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="p-5">
          <h2 className="text-[15px] font-semibold">Invite a candidate</h2>
          <p className="mt-1 text-[13px] text-fg-2">
            They get a link. No account, no password.
          </p>

          <div className="mt-4 space-y-4">
            <Field label="Candidate email" htmlFor="invite-email" error={error && !email ? error : undefined}>
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
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" htmlFor="invite-name" hint="Optional">
                <Input
                  id="invite-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Aditya Rao"
                  maxLength={80}
                />
              </Field>
              <Field label="Role" htmlFor="invite-role">
                <select
                  id="invite-role"
                  value={rubric}
                  onChange={(e) => setRubric(e.target.value)}
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
            <Field
              label="Résumé"
              htmlFor="invite-resume"
              hint="Optional. Used to pick the first question and to check claims against."
            >
              <Textarea
                id="invite-resume"
                value={resume}
                onChange={(e) => setResume(e.target.value)}
                placeholder="Paste the résumé text."
                maxLength={20000}
              />
            </Field>
          </div>

          {error && email && (
            <p role="alert" className="mt-3 text-[12px] text-bad">
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Create link
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
