"use client";

import { use, useCallback, useEffect, useState } from "react";

import { ScorecardView } from "@/components/Scorecard";
import { AppShell, Badge, Button, Card, Page, PageHeader, Skeleton } from "@/components/ui";
import { ApiError, api, type Scorecard } from "@/lib/api";

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [card, setCard] = useState<Scorecard | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setCard(await api.scorecard(id));
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load this interview.");
    }
  }, [id]);

  const live = !!card && card.startedAt !== null && !card.finished;

  // A live interview changes every few seconds. A finished one does not.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    if (!live) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load, live]);

  return (
    <AppShell>
      <PageHeader
        crumbs={[{ href: "/", label: "Interviews" }, { label: card?.candidate ?? "…" }]}
        title={
          card ? (
            <span className="flex items-center gap-3">
              {card.candidate}
              {live && (
                <Badge tone="accent" dot>
                  Live
                </Badge>
              )}
            </span>
          ) : (
            <Skeleton className="h-6 w-48" />
          )
        }
        description={card?.role_title}
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
        {!card && !error && <ScorecardSkeleton />}
        {card && <ScorecardView card={card} live={live} onChanged={load} />}
      </Page>
    </AppShell>
  );
}

function ScorecardSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-6">
        <Card>
          <Skeleton className="mb-4 h-4 w-40" />
          <Skeleton className="h-40 w-full" />
        </Card>
        <Card>
          <Skeleton className="mb-4 h-4 w-24" />
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="mb-5">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="mt-3 ml-12 h-14 w-full" />
            </div>
          ))}
        </Card>
      </div>
      <div className="space-y-4">
        <Card>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-3 h-[22px] w-24" />
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </Card>
        <Card>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-3 h-8 w-full" />
          <Skeleton className="mt-2 h-8 w-full" />
          <Skeleton className="mt-2 h-8 w-full" />
        </Card>
      </div>
    </div>
  );
}
