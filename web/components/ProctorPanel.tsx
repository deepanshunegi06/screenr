"use client";

import { useEffect, useRef } from "react";

import type { ProctorStatus } from "@/lib/proctor";

/**
 * The candidate's own camera feed, with what the checks currently see.
 *
 * Shown rather than hidden on purpose: if we are watching, they get to watch
 * too, and they can fix a framing problem themselves instead of collecting notes
 * they never knew about.
 */
export function ProctorPanel({
  stream,
  status,
  warnings,
  maxWarnings,
}: {
  stream: MediaStream | null;
  status: ProctorStatus | null;
  warnings: number;
  maxWarnings: number;
}) {
  const view = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = view.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  const state = !status
    ? { label: "Starting camera", tone: "text-fg-3", dot: "bg-fg-4" }
    : status.faces === 0
      ? { label: "No one in frame", tone: "text-warn", dot: "bg-warn" }
      : status.faces > 1
        ? { label: `${status.faces} people in frame`, tone: "text-warn", dot: "bg-warn" }
        : !status.calibrated
          ? { label: "Calibrating", tone: "text-fg-3", dot: "bg-fg-4" }
          : status.away
            ? { label: "Looking away", tone: "text-warn", dot: "bg-warn" }
            : { label: "In frame", tone: "text-fg-2", dot: "bg-ok" };

  return (
    <div className="rounded-lg border border-border bg-surface p-2 shadow-sm">
      <div
        className={`aspect-[4/3] w-[148px] overflow-hidden rounded-md bg-surface-3 ring-1 transition-colors ${
          status && (status.faces !== 1 || status.away) ? "ring-warn" : "ring-transparent"
        }`}
      >
        {/* Mirrored: an unmirrored self-view is disorienting. */}
        <video
          ref={view}
          muted
          playsInline
          className="h-full w-full -scale-x-100 object-cover"
        />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 px-0.5">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${state.dot}`} />
        <span className={`truncate text-[12px] ${state.tone}`}>{state.label}</span>
      </div>
      {maxWarnings > 0 && (
        <div className="mt-1 flex items-center gap-1 px-0.5" title={`${warnings} of ${maxWarnings} warnings used`}>
          {Array.from({ length: maxWarnings }, (_, i) => (
            <span
              key={i}
              aria-hidden
              className={`h-1 flex-1 rounded-full ${i < warnings ? "bg-bad" : "bg-surface-3"}`}
            />
          ))}
        </div>
      )}
      <p className="sr-only">
        {warnings} of {maxWarnings} warnings used. Video stays on your device.
      </p>
    </div>
  );
}
