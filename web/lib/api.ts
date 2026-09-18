const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const TOKEN_KEY = "screenr.recruiter";

export function saveToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function readToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}, auth = false): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (auth) {
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError("Couldn't reach the server. Check it's running and try again.", 0);
  }

  if (res.status === 401 && auth) {
    clearToken();
    // A full reload back to sign-in is the intent: the token is gone.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (typeof window !== "undefined") window.location.assign("/");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail)
      ? body.detail.map((d: { msg?: string }) => d.msg ?? "").filter(Boolean).join("; ")
      : body.detail;
    throw new ApiError(typeof detail === "string" && detail ? detail : `Request failed (${res.status})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------------ */
/* Types — mirror api/app/main.py responses exactly                          */
/* ------------------------------------------------------------------------ */

export type Recommendation = "advance" | "another_round" | "below_bar" | "inconclusive";
export type Confidence = "high" | "medium" | "low";
export type Decision = "advance" | "another_round" | "reject";

export type SessionRow = {
  id: string;
  candidate: string;
  candidateEmail: string;
  roleTitle: string;
  rubric: string;
  durationSeconds: number;
  turns: number;
  skillsCovered: number;
  skillsTotal: number;
  overall: number | null;
  confidence: Confidence;
  recommendation: Recommendation;
  started: boolean;
  finished: boolean;
  reviewed: boolean;
  decision: Decision | null;
  createdAt: string;
};

export type EvidenceItem = { quote: string; note: string; score: number; at: number };

export type SkillResult = {
  key: string;
  name: string;
  weight: number;
  cross_cutting: boolean;
  score: number | null;
  covered: boolean;
  evidence: EvidenceItem[];
};

export type ClaimResult = {
  id: string;
  text: string;
  status: "unverified" | "verified" | "refuted";
  note: string;
};

export type TranscriptTurn = {
  at: number;
  speaker: "agent" | "candidate" | "system";
  text: string;
  tools: string[];
};

export type IntegrityFlag = { kind: string; detail: string; at: number; shot: string | null };

/** The camera frame saved when a warning fired. An <img> cannot send an
 *  Authorization header, so the token rides in the query instead. */
export function evidenceUrl(sessionId: string, shot: string): string {
  return `${BASE}/sessions/${sessionId}/evidence/${shot}?token=${encodeURIComponent(readToken() ?? "")}`;
}

export type Usage = { agentHours: number; ttsCharacters: number; requests: number; costUsd: number } | null;

export type Scorecard = {
  session_id: string;
  candidate: string;
  candidateEmail: string;
  role_title: string;
  overall: number | null;
  confidence: Confidence;
  recommendation: Recommendation;
  stop_reason: string | null;
  escalation_note: string | null;
  duration_seconds: number;
  turns: number;
  skills: SkillResult[];
  claims: ClaimResult[];
  flags: { kind: string; detail: string }[];
  transcript: TranscriptTurn[];
  integrity: IntegrityFlag[];
  decision: Decision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  usage: Usage;
  createdAt: string;
  startedAt: string | null;
  finished: boolean;
};

export type ParsedResume = { text: string; name: string; characters: number };

export type BulkResult = {
  created: { sessionId: string; candidateEmail: string; candidateName: string; inviteToken: string }[];
  failed: { candidateEmail: string; reason: string }[];
};

export type CompareRow = {
  id: string;
  candidate: string;
  candidateEmail: string;
  overall: number | null;
  confidence: Confidence;
  recommendation: Recommendation;
  decision: Decision | null;
  finished: boolean;
  durationSeconds: number;
  integrityCount: number;
  scores: Record<string, number | null>;
  createdAt: string;
};

export type Comparison = {
  rubric: string;
  title: string;
  skills: { key: string; name: string; weight: number }[];
  candidates: CompareRow[];
};

export type Role = {
  key: string;
  title: string;
  skills: { key: string; name: string; weight: number; cross_cutting: boolean; what_good_looks_like: string }[];
};

export type EvalRun = {
  persona: string;
  description: string;
  recommendation: Recommendation;
  overall: number | null;
  confidence: Confidence;
  toolSequence: string[];
  questions: string[];
  transcript: { speaker: "agent" | "candidate"; text: string }[];
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
};

export type EvalRunState = {
  running: boolean;
  done: number;
  total: number;
  startedAt: string | null;
  error: string | null;
};

export type EvalReport = {
  ranAt: string | null;
  model: string;
  provider: string;
  runs: EvalRun[];
  errors: { persona: string; reason: string }[];
  summary: { total: number; passed: number; branchingProven: boolean };
  run: EvalRunState;
};

export type InterviewIntro = {
  candidate: string;
  roleTitle: string;
  maxMinutes: number;
  consented: boolean;
  proctoringConsented: boolean;
  started: boolean;
  finished: boolean;
};

export type InterviewState = {
  exists: boolean;
  candidate?: string;
  roleTitle?: string;
  finished?: boolean;
  elapsedSeconds?: number;
  transcript?: { at: number; speaker: string; text: string }[];
  skillsCovered?: number;
  skillsTotal?: number;
};

/* ------------------------------------------------------------------------ */
/* Client                                                                    */
/* ------------------------------------------------------------------------ */

export const api = {
  config: () => request<{ demoMode: boolean }>("/config"),

  login: (email: string, password: string) =>
    request<{ token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  demo: () => request<{ token: string }>("/auth/demo", { method: "POST" }),

  sessions: () => request<SessionRow[]>("/sessions", {}, true),

  invite: (input: { candidateEmail: string; candidateName?: string; rubric?: string; resumeText?: string }) =>
    request<{ sessionId: string; inviteToken: string; candidateEmail: string }>(
      "/sessions",
      { method: "POST", body: JSON.stringify(input) },
      true,
    ),

  parseResume: async (file: File): Promise<ParsedResume> => {
    const form = new FormData();
    form.append("file", file);
    const token = readToken();
    let res: Response;
    try {
      res = await fetch(`${BASE}/resumes/parse`, {
        method: "POST",
        body: form,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      throw new ApiError("Couldn't reach the server.", 0);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.detail ?? "Couldn't read that file.", res.status);
    return body as ParsedResume;
  },

  inviteMany: (
    candidates: { candidateEmail: string; candidateName?: string; rubric?: string; resumeText?: string }[],
  ) => request<BulkResult>("/sessions/bulk", { method: "POST", body: JSON.stringify({ candidates }) }, true),

  compare: (rubric: string) =>
    request<Comparison>(`/compare?rubric=${encodeURIComponent(rubric)}`, {}, true),

  reissueInvite: (id: string) =>
    request<{ inviteToken: string; sessionId: string }>(`/sessions/${id}/invite`, {}, true),

  scorecard: (id: string) => request<Scorecard>(`/sessions/${id}`, {}, true),

  decide: (id: string, decision: Decision) =>
    request<{ decision: Decision; decidedBy: string }>(
      `/sessions/${id}/decision`,
      { method: "POST", body: JSON.stringify({ decision }) },
      true,
    ),

  closeSession: (id: string) => request<{ closed: boolean }>(`/sessions/${id}/close`, { method: "POST" }, true),

  deleteSession: (id: string) => request<{ deleted: string }>(`/sessions/${id}`, { method: "DELETE" }, true),

  roles: () => request<Role[]>("/roles", {}, true),

  evals: () => request<EvalReport>("/evals", {}, true),

  runEvals: () => request<EvalRunState>("/evals/run", { method: "POST" }, true),

  intro: (token: string) => request<InterviewIntro>(`/interview/${token}`),

  interviewState: (token: string) => request<InterviewState>(`/interview/${token}/state`),

  consent: (token: string, recordingConsent: boolean, proctoringConsent: boolean) =>
    request<{ consented: boolean; proctoring: boolean }>("/interview/consent", {
      method: "POST",
      body: JSON.stringify({ token, recordingConsent, proctoringConsent }),
    }),
};

export function wsUrl(path: string) {
  return BASE.replace(/^http/, "ws") + path;
}

export function mmss(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function relativeTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
