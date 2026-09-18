"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Badge, Button, EmptyState, Skeleton, Table, Td, Th, Verdict } from "@/components/ui";
import { api, relativeTime, type Decision, type SessionRow } from "@/lib/api";

export type Filter = "all" | "review" | "live" | "decided";

export function matchesFilter(row: SessionRow, filter: Filter) {
  switch (filter) {
    case "review":
      return row.finished && !row.reviewed;
    case "live":
      return row.started && !row.finished;
    case "decided":
      return row.reviewed;
    default:
      return true;
  }
}

function StatusBadge({ row }: { row: SessionRow }) {
  if (!row.started) return <Badge>Not started</Badge>;
  if (!row.finished)
    return (
      <Badge tone="accent" dot>
        In progress · {row.skillsCovered}/{row.skillsTotal}
      </Badge>
    );
  if (!row.reviewed)
    return (
      <Badge tone="warn" dot>
        Needs review
      </Badge>
    );
  return <Badge tone="ok">Reviewed</Badge>;
}

const DECISION_LABEL: Record<Decision, { label: string; tone: "ok" | "warn" | "bad" }> = {
  advance: { label: "Advanced", tone: "ok" },
  another_round: { label: "Another round", tone: "warn" },
  reject: { label: "Rejected", tone: "bad" },
};

export function SessionsTable({
  rows,
  loading,
  onChanged,
  onInvite,
}: {
  rows: SessionRow[] | null;
  loading: boolean;
  onChanged: () => void;
  onInvite: () => void;
}) {
  const router = useRouter();
  const [cursor, setCursor] = useState(-1);
  const [menu, setMenu] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // j/k move, Enter opens. Only while the table itself has focus, so typing in
  // the search box does not navigate.
  useEffect(() => {
    const el = tableRef.current;
    if (!el || !rows?.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(rows.length - 1, c + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter" && cursor >= 0) {
        router.push(`/sessions/${rows[cursor].id}`);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [rows, cursor, router]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  async function copyLink(row: SessionRow) {
    setBusy(row.id);
    try {
      const { inviteToken } = await api.reissueInvite(row.id);
      const url = `${window.location.origin}/interview/${inviteToken}`;
      await navigator.clipboard?.writeText(url);
      setCopied(row.id);
      setTimeout(() => setCopied(null), 1500);
    } finally {
      setBusy(null);
      setMenu(null);
    }
  }

  async function closeSession(row: SessionRow) {
    setBusy(row.id);
    try {
      await api.closeSession(row.id);
      onChanged();
    } finally {
      setBusy(null);
      setMenu(null);
    }
  }

  async function remove(row: SessionRow) {
    if (confirming !== row.id) {
      setConfirming(row.id);
      setTimeout(() => setConfirming((c) => (c === row.id ? null : c)), 4000);
      return;
    }
    setBusy(row.id);
    try {
      await api.deleteSession(row.id);
      onChanged();
    } finally {
      setBusy(null);
      setMenu(null);
      setConfirming(null);
    }
  }

  if (loading && !rows) {
    return (
      <Table>
        <thead>
          <tr>
            <Th>Candidate</Th>
            <Th className="hidden md:table-cell">Role</Th>
            <Th>Status</Th>
            <Th align="right">Score</Th>
            <Th>Recommendation</Th>
            <Th className="hidden md:table-cell">Invited</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }, (_, i) => (
            <tr key={i}>
              <Td>
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="mt-1.5 h-3 w-44" />
              </Td>
              <Td className="hidden md:table-cell">
                <Skeleton className="h-3.5 w-36" />
              </Td>
              <Td>
                <Skeleton className="h-[22px] w-24" />
              </Td>
              <Td align="right">
                <Skeleton className="ml-auto h-3.5 w-8" />
              </Td>
              <Td>
                <Skeleton className="h-[22px] w-20" />
              </Td>
              <Td className="hidden md:table-cell">
                <Skeleton className="h-3.5 w-14" />
              </Td>
              <Td />
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }

  if (rows && rows.length === 0) {
    return (
      <EmptyState
        title="No interviews match"
        description="Invite a candidate and they get a link. When they finish, the scorecard lands here."
        action={
          <Button variant="primary" onClick={onInvite}>
            Invite candidate
          </Button>
        }
      />
    );
  }

  return (
    <div ref={tableRef} tabIndex={0} className="overflow-x-auto rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <Table>
        <thead>
          <tr>
            <Th>Candidate</Th>
            <Th className="hidden md:table-cell">Role</Th>
            <Th>Status</Th>
            <Th align="right">Score</Th>
            <Th>Recommendation</Th>
            <Th>Decision</Th>
            <Th className="hidden md:table-cell">Invited</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((row, i) => (
            <tr
              key={row.id}
              onClick={() => router.push(`/sessions/${row.id}`)}
              className={`cursor-pointer transition-colors hover:bg-surface-2 ${
                i === cursor ? "bg-accent-soft/40" : ""
              }`}
            >
              <Td>
                <Link
                  href={`/sessions/${row.id}`}
                  className="font-medium text-fg hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {row.candidate}
                </Link>
                <div className="text-[12px] text-fg-3">{row.candidateEmail}</div>
              </Td>
              <Td className="hidden text-fg-2 md:table-cell">{row.roleTitle}</Td>
              <Td>
                <StatusBadge row={row} />
              </Td>
              <Td align="right" className="tnum font-medium">
                {row.overall === null ? <span className="text-fg-4">—</span> : row.overall.toFixed(1)}
              </Td>
              <Td>{row.finished ? <Verdict value={row.recommendation} /> : <span className="text-fg-4">—</span>}</Td>
              <Td>
                {row.decision ? (
                  <Badge tone={DECISION_LABEL[row.decision].tone}>{DECISION_LABEL[row.decision].label}</Badge>
                ) : (
                  <span className="text-fg-4">—</span>
                )}
              </Td>
              <Td className="hidden text-fg-3 md:table-cell">{relativeTime(row.createdAt)}</Td>
              <Td align="right">
                <div className="relative inline-block" onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Actions for ${row.candidate}`}
                    aria-haspopup="menu"
                    aria-expanded={menu === row.id}
                    loading={busy === row.id}
                    onClick={() => setMenu(menu === row.id ? null : row.id)}
                  >
                    ···
                  </Button>
                  {menu === row.id && (
                    <div
                      role="menu"
                      className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-md border border-border bg-surface py-1 text-left shadow-md"
                    >
                      <MenuItem onClick={() => copyLink(row)}>
                        {copied === row.id ? "Copied" : "Copy invite link"}
                      </MenuItem>
                      {row.started && !row.finished && (
                        <MenuItem onClick={() => closeSession(row)}>Close interview</MenuItem>
                      )}
                      <MenuItem onClick={() => remove(row)} danger>
                        {confirming === row.id ? "Confirm delete" : "Delete"}
                      </MenuItem>
                    </div>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-[13px] hover:bg-surface-2 ${
        danger ? "text-bad" : "text-fg"
      }`}
    >
      {children}
    </button>
  );
}
