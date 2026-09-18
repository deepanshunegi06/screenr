"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  AppShell,
  Badge,
  Button,
  EmptyState,
  Page,
  PageHeader,
  Skeleton,
  Table,
  Td,
  Th,
  Verdict,
  inputClass,
} from "@/components/ui";
import { ApiError, api, mmss, type Comparison, type Role } from "@/lib/api";

/**
 * Everyone who interviewed for one role, against the same skills.
 *
 * A scorecard answers "how did this person do". The question a recruiter
 * actually has is "which of these eight do I take forward", and that needs them
 * side by side with the same columns.
 */

function scoreTone(score: number | null) {
  if (score === null) return "text-fg-4";
  if (score >= 4) return "text-ok";
  if (score >= 3) return "text-fg";
  return "text-warn";
}

export default function ComparePage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [rubric, setRubric] = useState("");
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .roles()
      .then((r) => {
        setRoles(r);
        setRubric((current) => current || r[0]?.key || "");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load roles."));
  }, []);

  const load = () => {
    if (!rubric) return;
    api
      .compare(rubric)
      .then((c) => {
        setData(c);
        setError("");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load the comparison."));
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rubric]);

  // Keep the last table on screen while a different role loads, but never show
  // one role's rows under another role's columns.
  const shown = data && data.rubric === rubric ? data : null;

  return (
    <AppShell>
      <PageHeader
        title="Compare"
        description="Everyone who interviewed for a role, scored against the same rubric."
        actions={
          <select
            aria-label="Role"
            value={rubric}
            onChange={(e) => setRubric(e.target.value)}
            className={`${inputClass} w-56`}
          >
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.title}
              </option>
            ))}
          </select>
        }
      />
      <Page width="wide">
        {error && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad-fg"
          >
            <span>{error}</span>
            <Button size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        )}

        {!shown && !error && <Skeleton className="h-64 w-full rounded-lg" />}

        {shown && shown.candidates.length === 0 && (
          <EmptyState
            title={`Nobody has interviewed for ${shown.title} yet`}
            description="Invite candidates and their scorecards will line up here."
            action={
              <Link href="/">
                <Button variant="primary">Go to interviews</Button>
              </Link>
            }
          />
        )}

        {shown && shown.candidates.length > 0 && (
          <>
            <Table className="[&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
              <thead>
                <tr>
                  {/* Pinned: scrolling right to reach a skill column is useless
                      if you lose track of whose row you are reading. */}
                  <Th className="sticky left-0 z-10 bg-surface-2">Candidate</Th>
                  <Th align="right">Overall</Th>
                  {shown.skills.map((s) => (
                    <Th key={s.key} align="right">
                      {s.name}
                    </Th>
                  ))}
                  <Th>Recommendation</Th>
                  <Th align="right">Length</Th>
                  <Th align="right">Flags</Th>
                </tr>
              </thead>
              <tbody>
                {shown.candidates.map((row) => (
                  <tr key={row.id} className="group hover:bg-surface-2">
                    <Td className="sticky left-0 z-10 bg-surface group-hover:bg-surface-2">
                      <Link
                        href={`/sessions/${row.id}`}
                        className="font-medium text-fg hover:underline"
                      >
                        {row.candidate}
                      </Link>
                      <div className="text-[12px] text-fg-3">{row.candidateEmail}</div>
                    </Td>
                    <Td align="right" className={`tnum text-[15px] font-semibold ${scoreTone(row.overall)}`}>
                      {row.overall === null ? "—" : row.overall.toFixed(1)}
                    </Td>
                    {shown.skills.map((s) => {
                      const score = row.scores[s.key] ?? null;
                      return (
                        <Td key={s.key} align="right" className={`tnum ${scoreTone(score)}`}>
                          {score === null ? (
                            <span title="Never asked about">—</span>
                          ) : (
                            score.toFixed(1)
                          )}
                        </Td>
                      );
                    })}
                    <Td>
                      {row.finished ? (
                        <Verdict value={row.recommendation} />
                      ) : (
                        <Badge tone="accent" dot>
                          In progress
                        </Badge>
                      )}
                      {row.decision && (
                        <div className="mt-1 text-[12px] text-fg-3">
                          Decided: {row.decision.replace("_", " ")}
                        </div>
                      )}
                    </Td>
                    <Td align="right" className="tnum text-fg-2">
                      {mmss(row.durationSeconds)}
                    </Td>
                    <Td align="right">
                      {row.integrityCount > 0 ? (
                        <Badge tone="warn">{row.integrityCount}</Badge>
                      ) : (
                        <span className="text-fg-4">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <p className="mt-3 text-[12px] text-fg-3">
              A dash means the interview never reached that skill — not a zero. Sorted by overall
              score; the ranking is a starting point for a conversation, not a decision.
            </p>
          </>
        )}
      </Page>
    </AppShell>
  );
}
