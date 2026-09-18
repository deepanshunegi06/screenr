"use client";

import { useEffect, useState } from "react";

import { AppShell, Badge, Button, Card, EmptyState, Page, PageHeader, Skeleton, Stat, Verdict } from "@/components/ui";
import { ApiError, api, relativeTime, type EvalReport, type EvalRun } from "@/lib/api";

export default function EvalsPage() {
  const [report, setReport] = useState<EvalReport | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    api
      .evals()
      .then((r) => {
        setReport(r);
        setError("");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load evals."));

  useEffect(() => {
    void load();
  }, []);

  return (
    <AppShell>
      <PageHeader
        title="Evals"
        description="Scripted candidates run through the agent in text. Same rubric, same opening — the tool sequence is the agent's own choice."
      />
      <Page width="wide">
        {error && (
          <div role="alert" className="mb-4 flex items-center justify-between rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad-fg">
            <span>{error}</span>
            <Button size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        )}

        {!report && !error && (
          <div className="grid gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[76px]" />
            ))}
          </div>
        )}

        {report && report.ranAt === null && (
          <EmptyState
            title="No eval results committed yet"
            description="Run the personas and commit the report: python -m app.cli --json evals/results/latest.json"
          />
        )}

        {report && report.ranAt !== null && (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Personas" value={report.summary.total} />
              <Stat
                label="Passed"
                value={`${report.summary.passed}/${report.summary.total}`}
                tone={report.summary.passed === report.summary.total ? "ok" : "warn"}
              />
              <Stat label="Model" value={<span className="text-[14px]">{report.model}</span>} sub={report.provider} />
              <Stat
                label="Branching"
                value={report.summary.branchingProven ? "Proven" : "Not shown"}
                tone={report.summary.branchingProven ? "ok" : "warn"}
                sub={`ran ${relativeTime(report.ranAt)}`}
              />
            </div>

            <p className="mt-6 max-w-2xl text-[13px] text-fg-2">
              Every persona got the same rubric and the same opening. The tool sequences below differ
              because the agent chose differently based on what each candidate said — that is the
              difference between an agent and a script.
            </p>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {report.runs.map((run) => (
                <RunCard key={run.persona} run={run} />
              ))}
            </div>
          </>
        )}
      </Page>
    </AppShell>
  );
}

const TOOL_SHORT: Record<string, string> = {
  record_evidence: "record",
  plan_probe: "probe",
  mark_claim: "claim",
  end_interview: "end",
  escalate_to_human: "escalate",
};

function RunCard({ run }: { run: EvalRun }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-[14px] font-semibold text-fg">{run.persona}</h2>
            <Badge tone={run.passed ? "ok" : "bad"} dot>
              {run.passed ? "Passed" : "Failed"}
            </Badge>
          </div>
          <p className="mt-1 text-[13px] text-fg-2">{run.description}</p>
        </div>
        <div className="shrink-0 text-right">
          <Verdict value={run.recommendation} />
          <div className="tnum mt-1 text-[12px] text-fg-3">
            {run.overall === null ? "—" : `${run.overall.toFixed(1)} / 5`} · {run.confidence}
          </div>
        </div>
      </div>

      <div className="mt-4 text-[12px] font-medium text-fg-2">Tool sequence</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {run.toolSequence.length === 0 && <span className="text-[12px] text-fg-3">none</span>}
        {run.toolSequence.map((t, i) => (
          <span
            key={i}
            title={t}
            className={`rounded-[4px] border px-1.5 py-0.5 font-mono text-[11px] ${
              t === "escalate_to_human"
                ? "border-transparent bg-warn-soft text-warn-fg"
                : t === "end_interview"
                  ? "border-transparent bg-ok-soft text-ok-fg"
                  : t === "plan_probe"
                    ? "border-transparent bg-accent-soft text-accent-fg"
                    : "border-border bg-surface-2 text-fg-2"
            }`}
          >
            {TOOL_SHORT[t] ?? t}
          </span>
        ))}
      </div>

      <div className="mt-4 text-[12px] font-medium text-fg-2">Checks</div>
      <ul className="mt-1.5 space-y-1">
        {run.checks.map((c) => (
          <li key={c.name} className="flex items-baseline gap-2 text-[13px]" title={c.detail}>
            <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${c.passed ? "bg-ok" : "bg-bad"}`} />
            <span className="text-fg">{c.name}</span>
            <span className="truncate text-fg-3">{c.detail}</span>
          </li>
        ))}
      </ul>

      <Button size="sm" variant="ghost" className="mt-3 -ml-2" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide transcript" : "Show transcript"}
      </Button>
      {open && (
        <div className="mt-2 space-y-3 border-t border-border pt-3">
          {run.transcript.map((t, i) => (
            <div key={i}>
              <div className="text-[11px] font-medium text-fg-3">{t.speaker === "agent" ? "Interviewer" : "Candidate"}</div>
              <p className="text-[13px] leading-relaxed text-fg">{t.text}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
