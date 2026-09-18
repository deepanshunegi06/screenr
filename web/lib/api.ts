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

async function request<T>(path: string, init: RequestInit = {}, auth = false): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (auth) {
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () =>
    request<{ demoPrefill: boolean; recruiterEmail: string; recruiterPassword: string }>("/config"),

  login: (email: string, password: string) =>
    request<{ token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  sessions: () => request<SessionRow[]>("/sessions", {}, true),

  invite: (candidateEmail: string, candidateName: string, resumeText: string) =>
    request<{ sessionId: string; inviteToken: string; candidateEmail: string }>(
      "/sessions",
      { method: "POST", body: JSON.stringify({ candidateEmail, candidateName, resumeText }) },
      true,
    ),

  scorecard: (id: string) => request<Record<string, unknown>>(`/sessions/${id}`, {}, true),

  decide: (id: string, decision: string) =>
    request<{ decision: string }>(
      `/sessions/${id}/decision`,
      { method: "POST", body: JSON.stringify({ decision }) },
      true,
    ),

  intro: (token: string) =>
    request<{
      candidate: string;
      roleTitle: string;
      maxMinutes: number;
      consented: boolean;
      started: boolean;
      finished: boolean;
    }>(`/interview/${token}`),

  consent: (token: string, recordingConsent: boolean, proctoringConsent: boolean) =>
    request<{ consented: boolean }>("/interview/consent", {
      method: "POST",
      body: JSON.stringify({ token, recordingConsent, proctoringConsent }),
    }),

  start: (token: string) =>
    request<{ say: string; finished: boolean }>("/interview/start", {
      method: "POST",
      body: JSON.stringify({ token, recordingConsent: true }),
    }),

  turn: (token: string, answer: string) =>
    request<{ say: string; finished: boolean; elapsedSeconds: number }>("/interview/turn", {
      method: "POST",
      body: JSON.stringify({ token, answer }),
    }),

  integrity: (token: string, kind: string, detail: string) =>
    request<{ recorded: boolean }>("/interview/integrity", {
      method: "POST",
      body: JSON.stringify({ token, kind, detail }),
    }).catch(() => ({ recorded: false })),
};

export type SessionRow = {
  id: string;
  candidate: string;
  roleTitle: string;
  durationSeconds: number;
  overall: number | null;
  confidence: "high" | "medium" | "low";
  recommendation: "advance" | "another_round" | "inconclusive";
  started: boolean;
  finished: boolean;
  reviewed: boolean;
  createdAt: string;
};

export function mmss(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
