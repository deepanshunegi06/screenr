"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { InviteDialog } from "@/components/InviteDialog";
import { SessionsTable, matchesFilter, type Filter } from "@/components/SessionsTable";
import { SignIn } from "@/components/SignIn";
import { AppShell, Button, Input, Page, PageHeader } from "@/components/ui";
import { ApiError, api, clearToken, readToken, type SessionRow } from "@/lib/api";

// The token lives in localStorage. Reading it through an external store keeps
// the first render consistent between server (no token) and client (token),
// without a set-state-in-effect.
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("screenr:auth", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("screenr:auth", callback);
  };
}

function useToken() {
  return useSyncExternalStore(subscribe, readToken, () => null);
}

function announceAuthChange() {
  window.dispatchEvent(new Event("screenr:auth"));
}

export default function Home() {
  const token = useToken();
  if (!token) return <SignIn onSignedIn={announceAuthChange} />;
  return (
    <Dashboard
      onSignOut={() => {
        clearToken();
        announceAuthChange();
      }}
    />
  );
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "review", label: "Needs review" },
  { key: "live", label: "In progress" },
  { key: "decided", label: "Decided" },
];

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.sessions();
      setRows(data);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load interviews.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll faster while something is live, slowly otherwise. The backend is a
  // local SQLite read; this is cheap.
  useEffect(() => {
    // Fetching on mount is what effects are for; the setState is after an await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const anyLive = rows?.some((r) => r.started && !r.finished) ?? false;
    const timer = setInterval(load, anyLive ? 5000 : 30000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, rows?.some((r) => r.started && !r.finished)]);

  const counts = useMemo(() => {
    const all = rows ?? [];
    return Object.fromEntries(
      FILTERS.map((f) => [f.key, all.filter((r) => matchesFilter(r, f.key)).length]),
    ) as Record<Filter, number>;
  }, [rows]);

  const visible = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        matchesFilter(r, filter) &&
        (!q || r.candidate.toLowerCase().includes(q) || r.candidateEmail.toLowerCase().includes(q)),
    );
  }, [rows, filter, query]);

  return (
    <AppShell
      right={
        <Button variant="ghost" size="sm" onClick={onSignOut} className="w-full justify-start">
          Sign out
        </Button>
      }
    >
      <PageHeader
        title="Interviews"
        description="Every scorecard here was recommended by the agent and decided by a person."
        actions={
          <Button variant="primary" onClick={() => setInviting(true)}>
            Invite candidate
          </Button>
        }
      />
      <Page width="wide">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="Filter interviews" className="flex gap-1 rounded-md border border-border bg-surface p-0.5 shadow-sm">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`h-7 rounded-[5px] px-2.5 text-[12px] font-medium transition-colors ${
                  filter === f.key ? "bg-surface-2 text-fg" : "text-fg-2 hover:text-fg"
                }`}
              >
                {f.label}
                <span className="tnum ml-1.5 text-fg-3">{counts[f.key] ?? 0}</span>
              </button>
            ))}
          </div>
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email"
            aria-label="Search interviews"
            className="w-64"
          />
        </div>

        {error && (
          <div role="alert" className="mb-4 flex items-center justify-between rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad-fg">
            <span>{error}</span>
            <Button size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        )}

        <SessionsTable
          rows={visible}
          loading={loading}
          onChanged={load}
          onInvite={() => setInviting(true)}
        />
      </Page>

      <InviteDialog open={inviting} onClose={() => setInviting(false)} onCreated={load} />
    </AppShell>
  );
}
