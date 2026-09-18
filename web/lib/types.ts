export type Recommendation = "advance" | "another_round" | "inconclusive";
export type Confidence = "high" | "medium" | "low";
export type ClaimStatus = "unverified" | "verified" | "refuted";

export type Evidence = {
  quote: string;
  note: string;
  score: number;
  /** Seconds into the interview. This is what anchors a score to the transcript. */
  at: number;
};

export type SkillResult = {
  key: string;
  name: string;
  score: number | null;
  covered: boolean;
  evidence: Evidence[];
};

export type Claim = {
  id: string;
  text: string;
  status: ClaimStatus;
  note: string;
};

export type Turn = {
  at: number;
  speaker: "agent" | "candidate";
  text: string;
  /** Tools the model chose on this turn. Empty when it just spoke. */
  tools: string[];
};

export type IntegrityFlag = {
  kind: string;
  detail: string;
  at: number;
};

export type Scorecard = {
  sessionId: string;
  candidate: string;
  roleTitle: string;
  overall: number;
  confidence: Confidence;
  recommendation: Recommendation;
  stopReason: string;
  escalationNote: string | null;
  durationSeconds: number;
  turns: number;
  costUsd: number;
  skills: SkillResult[];
  claims: Claim[];
  transcript: Turn[];
  /** Kept separate from skills on purpose. See docs/adr/005. */
  integrity: IntegrityFlag[];
};

export type SessionSummary = {
  id: string;
  candidate: string;
  roleTitle: string;
  finishedAt: string;
  durationSeconds: number;
  overall: number | null;
  confidence: Confidence;
  recommendation: Recommendation;
  reviewed: boolean;
};

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  advance: "Advance",
  another_round: "Another round",
  inconclusive: "Not enough evidence",
};
