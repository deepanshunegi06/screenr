"use client";

import { use, useEffect, useState } from "react";

import { AppShell, Badge, Button, Card, Page, PageHeader, Skeleton } from "@/components/ui";
import { ApiError, api, type Role } from "@/lib/api";

const ANCHORS = [
  ["5", "First person, specific numbers or names, a failure and what they changed, a decision they can defend."],
  ["4", "Specific and first person, a decision explained, but no failure or consequence."],
  ["3", "Concrete technology and one real decision, thin on why."],
  ["2", "Names things they used; no decision, no consequence, or passive voice."],
  ["1", "Buzzwords, or cannot say what they personally did."],
];

export default function RolePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const [role, setRole] = useState<Role | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    api
      .roles()
      .then((roles) => {
        const found = roles.find((r) => r.key === key);
        if (!found) setError("No such role.");
        else setRole(found);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this role."));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <AppShell>
      <PageHeader
        crumbs={[{ href: "/roles", label: "Roles" }, { label: role?.title ?? "…" }]}
        title={role?.title ?? <Skeleton className="h-6 w-56" />}
        description={role ? `${role.skills.length} skills · scored 1–5 against the anchors below` : undefined}
      />
      <Page>
        {error && (
          <div role="alert" className="mb-4 flex items-center justify-between rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad-fg">
            <span>{error}</span>
            <Button size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-3">
            {!role &&
              !error &&
              [0, 1, 2].map((i) => (
                <Card key={i}>
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="mt-3 h-12 w-full" />
                </Card>
              ))}
            {role?.skills.map((s) => (
              <Card key={s.key}>
                <div className="flex items-center gap-2">
                  <h2 className="text-[14px] font-semibold text-fg">{s.name}</h2>
                  <span className="font-mono text-[12px] text-fg-3">{s.key}</span>
                  {s.weight !== 1 && <Badge>weight {s.weight}</Badge>}
                  {"cross_cutting" in s && (s as { cross_cutting?: boolean }).cross_cutting && (
                    <Badge tone="accent">Scored from the whole conversation</Badge>
                  )}
                </div>
                <div className="mt-2 text-[12px] font-medium text-fg-2">What a strong answer contains</div>
                <p className="mt-1 text-[14px] leading-relaxed text-fg">{s.what_good_looks_like}</p>
              </Card>
            ))}
          </div>
          <Card className="lg:sticky lg:top-4 lg:self-start">
            <div className="text-[12px] font-medium text-fg-2">Scoring anchors</div>
            <p className="mt-1 text-[12px] text-fg-3">Same for every skill. The agent quotes the answer it scored.</p>
            <dl className="mt-3 space-y-2">
              {ANCHORS.map(([n, text]) => (
                <div key={n} className="flex gap-3 text-[13px]">
                  <dt className="tnum w-4 shrink-0 font-semibold text-fg">{n}</dt>
                  <dd className="text-fg-2">{text}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </Page>
    </AppShell>
  );
}
