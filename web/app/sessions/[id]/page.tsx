"use client";

import { use, useCallback, useEffect, useState } from "react";

import { Shell } from "@/components/Chrome";
import { ScorecardView } from "@/components/Scorecard";
import { api } from "@/lib/api";
import type { Scorecard } from "@/lib/types";

/** The API speaks snake_case; the UI speaks camelCase. One place to cross over. */
function toScorecard(raw: Record<string, any>): Scorecard {
  return {
    sessionId: raw.session_id,
    candidate: raw.candidate ?? "Candidate",
    roleTitle: raw.role_title,
    overall: raw.overall ?? 0,
    confidence: raw.confidence,
    recommendation: raw.recommendation,
    stopReason: raw.stop_reason ?? "",
    escalationNote: raw.escalation_note ?? null,
    durationSeconds: Math.max(raw.duration_seconds ?? 0, 60),
    turns: raw.turns ?? 0,
    costUsd: raw.cost_usd ?? 0,
    skills: (raw.skills ?? []).map((s: any) => ({
      key: s.key,
      name: s.name,
      score: s.score,
      covered: s.covered,
      evidence: (s.evidence ?? []).map((e: any) => ({
        quote: e.quote,
        note: e.note,
        score: e.score,
        at: e.at ?? 0,
      })),
    })),
    claims: raw.claims ?? [],
    transcript: raw.transcript ?? [],
    integrity: raw.integrity ?? [],
  };
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [card, setCard] = useState<Scorecard | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .scorecard(id)
      .then((raw) => setCard(toScorecard(raw)))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load"));
  }, [id]);

  const decide = useCallback(
    async (decision: string) => {
      await api.decide(id, decision);
    },
    [id],
  );

  return (
    <Shell back={{ href: "/", label: "All interviews" }}>
      {error && <p className="text-[14px] text-rust">{error}</p>}
      {!card && !error && <p className="text-[14px] text-muted">Loading…</p>}
      {card && <ScorecardView card={card} onDecide={decide} />}
    </Shell>
  );
}
