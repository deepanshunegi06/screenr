"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CoverageMap } from "@/components/CoverageMap";
import { Badge, Button, Card, Kbd, SectionTitle, Stat, Verdict } from "@/components/ui";
import { ApiError, api, mmss, relativeTime, type Decision, type Scorecard, type TranscriptTurn } from "@/lib/api";

const TOOL_LABEL: Record<string, string> = {
  record_evidence: "Recorded evidence",
  plan_probe: "Planned follow-up",
  mark_claim: "Checked résumé claim",
  end_interview: "Ended interview",
  escalate_to_human: "Flagged for review",
};

const STOP_LABEL: Record<string, string> = {
  sufficient_evidence: "Every skill covered",
  question_bank_exhausted: "Ran out of questions",
  duration_cap: "Time limit reached",
  turn_cap: "Turn limit reached",
  candidate_ended: "Candidate ended it",
  incomplete: "Closed by recruiter",
};

const DECISION_LABEL: Record<Decision, string> = {
  advance: "Advance",
  another_round: "Another round",
  reject: "Reject",
};

// Plain words for the recruiter. The raw kind is a machine label.
const INTEGRITY_LABEL: Record<string, string> = {
  tab_hidden: "Switched away from the interview",
  no_face: "No one in frame",
  multiple_faces: "More than one person in frame",
  camera_lost: "Camera stopped",
};

const WORDS = /[a-z0-9]+/g;

/** The candidate turn a piece of evidence came from. Timestamps are stamped at
 *  different moments (the answer when it was heard, the evidence when the agent
 *  thought), so this looks for the last turn at or before the evidence that
 *  actually contains the quote's words. */
function resolveTurn(transcript: TranscriptTurn[], quote: string, at: number): number {
  const words = quote.toLowerCase().match(WORDS) ?? [];
  let fallback = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i];
    if (t.speaker !== "candidate" || t.at > at + 2) continue;
    if (fallback === -1) fallback = i;
    const text = t.text.toLowerCase();
    const hits = words.filter((w) => text.includes(w)).length;
    if (words.length && hits >= 0.6 * words.length) return i;
  }
  return fallback;
}

export function ScorecardView({
  card,
  live,
  onChanged,
}: {
  card: Scorecard;
  live: boolean;
  onChanged: () => void;
}) {
  const [focused, setFocused] = useState<number | null>(null);
  const [showTools, setShowTools] = useState(true);
  const [copied, setCopied] = useState(false);
  const evidenceRefs = useRef<Record<string, HTMLElement | null>>({});

  const candidateFirst = card.candidate.split(" ")[0] || "Candidate";
  const regular = card.skills.filter((s) => !("cross_cutting" in s && (s as { cross_cutting?: boolean }).cross_cutting));
  const uncovered = regular.filter((s) => !s.covered);

  const jumpToTurn = useCallback(
    (quote: string, at: number) => {
      const index = resolveTurn(card.transcript, quote, at);
      if (index < 0) return;
      setFocused(index);
      document.getElementById(`turn-${index}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => setFocused((f) => (f === index ? null : f)), 2500);
    },
    [card.transcript],
  );

  const jumpToEvidence = useCallback((skillKey: string, index: number) => {
    evidenceRefs.current[`${skillKey}-${index}`]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const summary = useMemo(() => buildSummary(card), [card]);

  async function copySummary() {
    try {
      await navigator.clipboard?.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable on insecure origins; nothing to do
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-6">
        <Card>
          <SectionTitle aside="Each mark is one recorded piece of evidence">What was covered</SectionTitle>
          <CoverageMap
            skills={card.skills}
            integrity={card.integrity}
            durationSeconds={card.duration_seconds}
            onSelect={jumpToEvidence}
          />
          {uncovered.length > 0 && !live && (
            <p className="mt-3 text-[13px] text-fg-2">
              {uncovered.length === 1
                ? `${uncovered[0].name} was never asked about. It's unscored, not scored zero.`
                : `${uncovered.length} skills were never asked about. They're unscored, not scored zero.`}
            </p>
          )}
        </Card>

        <Card>
          <SectionTitle aside={`${card.skills.reduce((n, s) => n + s.evidence.length, 0)} quotes`}>Evidence</SectionTitle>
          <div className="divide-y divide-border">
            {card.skills.map((skill) => (
              <div key={skill.key} className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-baseline gap-3">
                  <span className="tnum w-9 shrink-0 text-[15px] font-semibold text-fg">
                    {skill.score === null ? <span className="text-fg-4">—</span> : skill.score.toFixed(1)}
                  </span>
                  <span className="text-[14px] font-medium text-fg">{skill.name}</span>
                  {!skill.covered && <Badge>Not asked</Badge>}
                  {skill.weight !== 1 && (
                    <span className="text-[12px] text-fg-3">weight {skill.weight}</span>
                  )}
                </div>
                {skill.evidence.map((item, i) => (
                  <div
                    key={i}
                    ref={(el) => {
                      evidenceRefs.current[`${skill.key}-${i}`] = el;
                    }}
                    className="mt-3 pl-12"
                  >
                    <blockquote className="rounded-md border-l-2 border-accent bg-surface-2/60 px-3 py-2 text-[14px] leading-relaxed text-fg">
                      {item.quote}
                    </blockquote>
                    <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-fg-2">
                      <span>{item.note}</span>
                      <button
                        onClick={() => jumpToTurn(item.quote, item.at)}
                        className="font-mono text-[12px] text-accent hover:underline"
                      >
                        {mmss(item.at)} in transcript
                      </button>
                      <span className="tnum text-fg-3">scored {item.score}</span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Card>

        {card.claims.length > 0 && (
          <Card>
            <SectionTitle>Résumé claims</SectionTitle>
            <ul className="divide-y divide-border">
              {card.claims.map((claim) => (
                <li key={claim.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="w-[88px] shrink-0">
                    {claim.status === "verified" ? (
                      <Badge tone="ok">Verified</Badge>
                    ) : claim.status === "refuted" ? (
                      <Badge tone="bad">Refuted</Badge>
                    ) : (
                      <Badge>Not checked</Badge>
                    )}
                  </div>
                  <div className="min-w-0 text-[14px] leading-relaxed text-fg">
                    {claim.text}
                    {claim.note && <div className="mt-0.5 text-[13px] text-fg-2">{claim.note}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <SectionTitle
            aside={
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={showTools}
                  onChange={(e) => setShowTools(e.target.checked)}
                  className="accent-accent"
                />
                Show agent actions
              </label>
            }
          >
            Transcript
          </SectionTitle>
          {card.transcript.length === 0 ? (
            <p className="text-[13px] text-fg-3">Nothing yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {card.transcript.map((turn, i) => (
                <TurnRow
                  key={i}
                  index={i}
                  turn={turn}
                  candidate={candidateFirst}
                  highlighted={focused === i}
                  showTools={showTools}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start print:hidden">
        <Card>
          <div className="text-[12px] font-medium text-fg-2">Agent recommendation</div>
          <div className="mt-2 flex items-center gap-2">
            {live ? <Badge tone="accent" dot>In progress</Badge> : <Verdict value={card.recommendation} />}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Stat label="Overall" value={card.overall === null ? "—" : card.overall.toFixed(1)} sub="out of 5" />
            <Stat label="Confidence" value={card.confidence} />
          </div>
          {live && (
            <p className="mt-3 text-[13px] text-fg-2">
              {regular.length - uncovered.length} of {regular.length} skills covered so far.
            </p>
          )}
          {card.escalation_note && (
            <div className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn-fg">
              <span className="font-medium">Flagged for review.</span> {card.escalation_note}
            </div>
          )}
        </Card>

        {!live && <DecisionPanel key={card.decision ?? "undecided"} card={card} onChanged={onChanged} />}

        <Card>
          <div className="text-[12px] font-medium text-fg-2">Details</div>
          <dl className="mt-2 space-y-1.5 text-[13px]">
            <Row k="Email" v={card.candidateEmail} />
            <Row k="Role" v={card.role_title} />
            <Row k="Started" v={card.startedAt ? relativeTime(card.startedAt) : "Not yet"} />
            <Row k="Duration" v={mmss(card.duration_seconds)} />
            <Row k="Turns" v={String(card.turns)} />
            {card.stop_reason && <Row k="Ended" v={STOP_LABEL[card.stop_reason] ?? card.stop_reason} />}
            {card.usage && <Row k="Voice cost" v={`$${card.usage.costUsd.toFixed(2)}`} />}
          </dl>
        </Card>

        {card.integrity.length > 0 && (
          <Card>
            <div className="text-[12px] font-medium text-fg-2">Integrity signals</div>
            <p className="mt-1 text-[12px] text-fg-3">
              Browser observations for your judgement. Not part of any score.
            </p>
            <ul className="mt-2 space-y-1.5 text-[13px]">
              {card.integrity.map((f, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="text-fg">
                    {INTEGRITY_LABEL[f.kind] ?? f.kind}
                    <span className="mt-0.5 block text-[12px] text-fg-3">{f.detail}</span>
                  </span>
                  <span className="tnum shrink-0 font-mono text-[12px] text-fg-3">{mmss(f.at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="flex gap-2">
          <Button onClick={copySummary} className="flex-1">
            {copied ? "Copied" : "Copy summary"}
          </Button>
          <Button onClick={() => window.print()} className="flex-1">
            Print
          </Button>
        </div>
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-fg-3">{k}</dt>
      <dd className="truncate text-right text-fg">{v}</dd>
    </div>
  );
}

function DecisionPanel({ card, onChanged }: { card: Scorecard; onChanged: () => void }) {
  const [editing, setEditing] = useState(card.decision === null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState("");

  const decide = useCallback(
    async (value: Decision) => {
      if (value === "reject" && !confirmReject) {
        setConfirmReject(true);
        setTimeout(() => setConfirmReject(false), 5000);
        return;
      }
      setBusy(value);
      setError("");
      try {
        await api.decide(card.session_id, value);
        setEditing(false);
        setConfirmReject(false);
        onChanged();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Couldn't record that. Try again.");
      } finally {
        setBusy(null);
      }
    },
    [card.session_id, confirmReject, onChanged],
  );

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "1") void decide("advance");
      if (e.key === "2") void decide("another_round");
      if (e.key === "3") void decide("reject");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, decide]);

  return (
    <Card>
      <div className="text-[12px] font-medium text-fg-2">Your decision</div>
      {!editing && card.decision ? (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <Badge tone={card.decision === "advance" ? "ok" : card.decision === "reject" ? "bad" : "warn"}>
              {DECISION_LABEL[card.decision]}
            </Badge>
          </div>
          <p className="mt-2 text-[12px] text-fg-3">
            by {card.decidedBy ?? "recruiter"}
            {card.decidedAt ? ` · ${relativeTime(card.decidedAt)}` : ""}
          </p>
          <Button size="sm" variant="ghost" className="mt-2 -ml-2" onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <Button variant="primary" className="w-full justify-between" loading={busy === "advance"} onClick={() => decide("advance")}>
            Advance <Kbd>1</Kbd>
          </Button>
          <Button className="w-full justify-between" loading={busy === "another_round"} onClick={() => decide("another_round")}>
            Another round <Kbd>2</Kbd>
          </Button>
          <Button variant="danger" className="w-full justify-between" loading={busy === "reject"} onClick={() => decide("reject")}>
            {confirmReject ? "Confirm reject" : "Reject"} <Kbd>3</Kbd>
          </Button>
          {error && (
            <p role="alert" className="text-[12px] text-bad">
              {error}
            </p>
          )}
          <p className="text-[12px] text-fg-3">Nothing is sent to the candidate.</p>
        </div>
      )}
    </Card>
  );
}

function TurnRow({
  index,
  turn,
  candidate,
  highlighted,
  showTools,
}: {
  index: number;
  turn: TranscriptTurn;
  candidate: string;
  highlighted: boolean;
  showTools: boolean;
}) {
  const isAgent = turn.speaker === "agent";
  const isSystem = turn.speaker === "system";
  return (
    <div
      id={`turn-${index}`}
      className={`flex gap-4 py-3 transition-colors first:pt-0 last:pb-0 ${highlighted ? "-mx-2 rounded-md bg-accent-soft px-2" : ""}`}
    >
      <span className="tnum w-10 shrink-0 pt-0.5 font-mono text-[12px] text-fg-3">{mmss(turn.at)}</span>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-[12px] font-medium text-fg-3">
          {isAgent ? "Interviewer" : isSystem ? "System" : candidate}
        </div>
        <p className={`text-[14px] leading-relaxed ${isSystem ? "font-mono text-[12px] text-fg-3" : "text-fg"}`}>
          {turn.text}
        </p>
        {showTools && turn.tools.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {turn.tools.map((t, i) => (
              <Badge key={i}>{TOOL_LABEL[t] ?? t}</Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function buildSummary(card: Scorecard): string {
  const lines = [
    `# ${card.candidate} — ${card.role_title}`,
    "",
    `Recommendation: ${card.recommendation} (${card.confidence} confidence)`,
    `Overall: ${card.overall === null ? "—" : card.overall.toFixed(1)}/5 · ${mmss(card.duration_seconds)} · ${card.turns} turns`,
    card.stop_reason ? `Ended: ${STOP_LABEL[card.stop_reason] ?? card.stop_reason}` : "",
    "",
    "## Skills",
  ];
  for (const s of card.skills) {
    lines.push(`- ${s.name}: ${s.score === null ? "not asked" : `${s.score.toFixed(1)}/5`}`);
    for (const e of s.evidence) lines.push(`  > "${e.quote}" — ${e.note}`);
  }
  if (card.claims.length) {
    lines.push("", "## Résumé claims");
    for (const c of card.claims) lines.push(`- [${c.status}] ${c.text}${c.note ? ` — ${c.note}` : ""}`);
  }
  if (card.decision) lines.push("", `Decision: ${card.decision} by ${card.decidedBy ?? "recruiter"}`);
  return lines.filter((l) => l !== undefined).join("\n");
}
