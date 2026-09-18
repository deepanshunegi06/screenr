"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, Field, Input, SectionTitle, Textarea, inputClass } from "@/components/ui";
import { ApiError, api, type Role, type RoleSkill } from "@/lib/api";

/**
 * Writing a role.
 *
 * The field that matters is "what a strong answer contains". It goes into the
 * interviewer's prompt word for word, so it is given the most room on the page
 * and the hint says what makes one useful: something a candidate either did or
 * did not do, not an adjective.
 */

type Draft = Omit<RoleSkill, "key">;

const BLANK: Draft = { name: "", what_good_looks_like: "", weight: 1, cross_cutting: false };

/** Keys are derived from the name on save, so the editor never carries one. */
const editable = (skills: RoleSkill[]): Draft[] =>
  skills.map((s) => ({
    name: s.name,
    what_good_looks_like: s.what_good_looks_like,
    weight: s.weight,
    cross_cutting: s.cross_cutting,
  }));

export function RoleEditor({ existing }: { existing?: Role }) {
  const router = useRouter();
  const [title, setTitle] = useState(existing?.title ?? "");
  const [skills, setSkills] = useState<Draft[]>(
    existing ? editable(existing.skills) : [{ ...BLANK }, { ...BLANK }],
  );
  const [jd, setJd] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const edit = (index: number, patch: Partial<Draft>) =>
    setSkills((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  async function draftFromJd() {
    setDrafting(true);
    setError("");
    try {
      const draft = await api.draftRole(jd);
      setTitle(draft.title);
      setSkills(editable(draft.skills));
      setJd("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't draft from that.");
    } finally {
      setDrafting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    const body = { title: title.trim(), skills };
    try {
      const saved = existing ? await api.updateRole(existing.key, body) : await api.createRole(body);
      router.push(`/roles/${saved.key}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the role.");
      setSaving(false);
    }
  }

  const askable = skills.filter((s) => !s.cross_cutting).length;

  return (
    <div className="space-y-5">
      {!existing && (
        <Card>
          <SectionTitle aside="Optional">Start from a job description</SectionTitle>
          <p className="mb-2.5 text-[13px] text-fg-2">
            Paste the posting and get a first draft of the skills. Nothing is saved until you have
            read it — you are writing the questions every candidate for this role will face.
          </p>
          <Textarea
            aria-label="Job description"
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder="Paste the job description here."
            className="min-h-[120px]"
            maxLength={8000}
          />
          <div className="mt-2.5 flex items-center gap-3">
            <Button onClick={draftFromJd} loading={drafting} disabled={jd.trim().length < 40}>
              Draft the skills
            </Button>
            <span className="text-[12px] text-fg-3">
              {jd.trim().length < 40 ? "Paste at least a paragraph." : "Overwrites what's below."}
            </span>
          </div>
        </Card>
      )}

      <Card>
        <Field label="Role title" htmlFor="role-title" hint="What a candidate would call the job.">
          <Input
            id="role-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Data analyst intern"
            maxLength={80}
            autoFocus
          />
        </Field>
      </Card>

      <Card>
        <SectionTitle aside={`${skills.length} of 8`}>Skills</SectionTitle>
        <div className="divide-y divide-border">
          {skills.map((skill, i) => (
            <div key={i} className="py-4 first:pt-0 last:pb-0">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                    <Field label="Skill" htmlFor={`skill-${i}`}>
                      <Input
                        id={`skill-${i}`}
                        value={skill.name}
                        onChange={(e) => edit(i, { name: e.target.value })}
                        placeholder="SQL and data modelling"
                        maxLength={60}
                      />
                    </Field>
                    <Field label="Weight" htmlFor={`weight-${i}`}>
                      <select
                        id={`weight-${i}`}
                        value={String(skill.weight)}
                        onChange={(e) => edit(i, { weight: Number(e.target.value) })}
                        className={inputClass}
                      >
                        <option value="0.5">0.5 — minor</option>
                        <option value="1">1 — normal</option>
                        <option value="2">2 — double</option>
                      </select>
                    </Field>
                  </div>

                  <Field
                    label="What a strong answer contains"
                    htmlFor={`good-${i}`}
                    hint="This goes to the interviewer word for word. Name something they either did or didn't do — a decision and its reason, a failure and how they found it. Not “solid understanding”."
                  >
                    <Textarea
                      id={`good-${i}`}
                      value={skill.what_good_looks_like}
                      onChange={(e) => edit(i, { what_good_looks_like: e.target.value })}
                      placeholder="Describes a join they actually needed and why the tables split that way. Names one query that was slow and what they changed."
                      maxLength={600}
                      className="min-h-[76px]"
                    />
                  </Field>

                  <label className="flex cursor-pointer items-start gap-2 text-[13px] text-fg-2">
                    <input
                      type="checkbox"
                      checked={skill.cross_cutting}
                      onChange={(e) => edit(i, { cross_cutting: e.target.checked, weight: e.target.checked ? 0.5 : 1 })}
                      className="mt-0.5 accent-accent"
                    />
                    <span>
                      Judge this from the whole conversation
                      <span className="mt-0.5 block text-[12px] text-fg-3">
                        No question of its own — scored from how they talked. Communication is the
                        usual one.
                      </span>
                    </span>
                  </label>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSkills((list) => list.filter((_, j) => j !== i))}
                  disabled={skills.length <= 2}
                  title={skills.length <= 2 ? "A role needs at least two skills" : "Remove this skill"}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>

        <Button
          className="mt-4"
          onClick={() => setSkills((list) => [...list, { ...BLANK }])}
          disabled={skills.length >= 8}
        >
          Add a skill
        </Button>
      </Card>

      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-fg-3">
          {askable === 0
            ? "At least one skill needs a question of its own."
            : `${askable} skill${askable === 1 ? "" : "s"} the interviewer will ask about.`}
        </span>
        <div className="flex gap-2">
          <Button onClick={() => router.back()}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!title.trim() || askable === 0}>
            {existing ? "Save changes" : "Create role"}
          </Button>
        </div>
      </div>
    </div>
  );
}
