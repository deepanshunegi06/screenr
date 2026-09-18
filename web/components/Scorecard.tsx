"use client";

import { useState } from "react";

import { CoverageMap } from "@/components/CoverageMap";
import { Verdict, buttonClass, ghostButtonClass } from "@/components/Chrome";
import { mmss } from "@/lib/api";
import type { Scorecard as Card, Turn } from "@/lib/types";

/**
 * Reading order is the argument: what was covered, then the evidence, then the
 * transcript it came from, and only then a decision. The overall number is
 * deliberately not the first thing on the page.
 */
export function ScorecardView({
  card,
  onDecide,
}: {
  card: Card;
  onDecide?: (decision: string) => Promise<void>;
}) {
  const [focused, setFocused] = useState<number | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decision, setDecision] = useState<string | null>(null);

  const uncovered = card.skills.filter((s) => !s.covered);

  async function decide(value: string) {
    if (!onDecide) return;
    setDeciding(true);
    try {
      await onDecide(value);
      setDecision(value);
    } finally {
      setDeciding(false);
    }
  }

  return (
    <div className="pb-24">
      <header className="flex flex-wrap items-start justify-between gap-6 border-b border-rule pb-7">
        <div>
          <p className="eyebrow">{card.roleTitle}</p>
          <h1 className="mt-2 font-display text-[32px] leading-tight text-ink">
            {card.candidate}
          </h1>
          <p className="mt-2 font-mono text-[12px] text-muted">
            {mmss(card.durationSeconds)} · {card.turns} turns · ${card.costUsd.toFixed(2)}
          </p>
        </div>
        <div className="text-right">
          <Verdict recommendation={card.recommendation} size="lg" />
          <p className="mt-3 font-display text-[40px] leading-none text-ink">
            {card.overall || "—"}
            <span className="ml-1 font-sans text-[14px] text-faint">/5</span>
          </p>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            {card.confidence} confidence
          </p>
        </div>
      </header>

      {card.escalationNote && (
        <p className="mt-6 border-l-2 border-rust bg-rust-soft/50 px-4 py-3 text-[14px] text-ink">
          <span className="font-medium">The agent stepped back.</span> {card.escalationNote}
        </p>
      )}

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <p className="eyebrow">What was actually covered</p>
          <p className="text-[12px] text-muted">Each mark is one recorded piece of evidence</p>
        </div>
        <div className="mt-4">
          <CoverageMap skills={card.skills} durationSeconds={card.durationSeconds} />
        </div>
        {uncovered.length > 0 && (
          <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-amber">
            {uncovered.length === 1
              ? `${uncovered[0].name} was never asked about. It is unscored, not scored zero.`
              : `${uncovered.length} skills were never asked about. They are unscored, not scored zero.`}
          </p>
        )}
      </section>

      <section className="mt-12">
        <p className="eyebrow">Evidence</p>
        <div className="mt-4">
          {card.skills.map((skill) => (
            <div key={skill.key} className="border-t border-rule py-5">
              <div className="flex items-baseline gap-4">
                <span className="w-9 shrink-0 font-mono text-[15px] text-ink">
                  {skill.score?.toFixed(1) ?? "—"}
                </span>
                <span className="text-[15px] text-ink">{skill.name}</span>
              </div>

              {skill.evidence.length === 0 ? (
                <p className="mt-2 pl-13 text-[13px] text-amber">
                  No evidence gathered.
                </p>
              ) : (
                skill.evidence.map((item, i) => (
                  <blockquote key={i} className="mt-3 pl-13">
                    <p className="border-l-2 border-pine pl-4 font-display text-[17px] leading-relaxed text-ink-soft">
                      {item.quote}
                    </p>
                    <footer className="mt-2 pl-4 text-[13px] text-muted">
                      {item.note}{" "}
                      <button
                        onClick={() => setFocused(item.at)}
                        className="font-mono text-[12px] text-pine underline-offset-4 hover:underline"
                      >
                        {mmss(item.at)} ↗
                      </button>
                    </footer>
                  </blockquote>
                ))
              )}
            </div>
          ))}
        </div>
      </section>

      {card.claims.length > 0 && (
        <section className="mt-12">
          <p className="eyebrow">Résumé claims</p>
          <ul className="mt-4">
            {card.claims.map((claim) => (
              <li key={claim.id} className="flex gap-4 border-t border-rule py-3.5">
                <span
                  className={`mt-0.5 w-[70px] shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] ${
                    claim.status === "verified"
                      ? "text-pine"
                      : claim.status === "refuted"
                        ? "text-rust"
                        : "text-faint"
                  }`}
                >
                  {claim.status === "unverified" ? "not asked" : claim.status}
                </span>
                <span className="text-[14px] leading-relaxed text-ink">
                  {claim.text}
                  {claim.note && (
                    <span className="mt-1 block text-[13px] text-muted">{claim.note}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-12">
        <p className="eyebrow">Transcript</p>
        <div className="mt-4 border-t border-rule">
          {card.transcript.map((turn, i) => (
            <TurnRow key={i} turn={turn} highlighted={focused === turn.at} />
          ))}
        </div>
      </section>

      {card.integrity.length > 0 && (
        <section className="mt-12">
          <p className="eyebrow">Integrity signals</p>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
            Browser-side observations, for your judgement. They are not part of any score
            and none of them mean cheating on their own.
          </p>
          <ul className="mt-4">
            {card.integrity.map((flag, i) => (
              <li key={i} className="flex gap-4 border-t border-rule py-3 text-[14px]">
                <span className="w-[110px] shrink-0 font-mono text-[12px] text-faint">
                  {flag.kind}
                </span>
                <span className="text-ink">{flag.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {onDecide && (
        <section className="mt-14 border-t-2 border-ink pt-7">
          <p className="font-display text-[22px] text-ink">Your call</p>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted">
            The agent gathered the evidence above and recommended{" "}
            <span className="text-ink">
              {card.recommendation === "advance"
                ? "advancing"
                : card.recommendation === "another_round"
                  ? "another round"
                  : "that there isn't enough to go on"}
            </span>
            . Nothing has been sent to the candidate.
          </p>
          {decision ? (
            <p className="mt-5 font-mono text-[13px] text-pine">
              Recorded: {decision.replace("_", " ")}
            </p>
          ) : (
            <div className="mt-5 flex flex-wrap gap-3">
              <button className={buttonClass} disabled={deciding} onClick={() => decide("advance")}>
                Advance to round 2
              </button>
              <button
                className={ghostButtonClass}
                disabled={deciding}
                onClick={() => decide("another_round")}
              >
                Another round
              </button>
              <button
                className={ghostButtonClass}
                disabled={deciding}
                onClick={() => decide("reject")}
              >
                Reject
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function TurnRow({ turn, highlighted }: { turn: Turn; highlighted: boolean }) {
  const isAgent = turn.speaker === "agent";
  return (
    <div
      className={`flex gap-5 border-b border-rule-soft py-4 transition-colors ${
        highlighted ? "bg-pine-soft/50" : ""
      }`}
    >
      <span className="w-12 shrink-0 pt-0.5 font-mono text-[12px] text-faint">
        {mmss(turn.at)}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={`text-[15px] leading-relaxed ${
            isAgent ? "text-ink" : "font-display text-[17px] text-ink-soft"
          }`}
        >
          {turn.text}
        </p>
        {turn.tools.length > 0 && (
          <p className="mt-2 font-mono text-[11px] text-pine">
            {turn.tools.join("  →  ")}
          </p>
        )}
      </div>
      <span className="w-[68px] shrink-0 text-right font-mono text-[11px] uppercase tracking-[0.08em] text-faint">
        {isAgent ? "agent" : "candidate"}
      </span>
    </div>
  );
}
