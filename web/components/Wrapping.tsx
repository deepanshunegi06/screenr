"use client";

import { useEffect, useState } from "react";

/**
 * What the candidate sees between "I'm done" and the scorecard existing.
 *
 * The work behind this is quick, but "quick" still reads as broken on a blank
 * screen -- the previous version sat silent and people clicked End four times.
 * So: an immediate acknowledgement, named steps that advance on their own, and
 * motion that shows the page is alive. The steps are honest about what is
 * happening; none of them wait on a response to appear.
 */

const STEPS = [
  { label: "Saving your answers", ms: 700 },
  { label: "Filing the evidence the interviewer recorded", ms: 1100 },
  { label: "Handing it to the hiring team", ms: 900 },
];

export function Wrapping({ done, removed }: { done: boolean; removed?: boolean }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (step >= STEPS.length - 1) return;
    const timer = setTimeout(() => setStep((s) => s + 1), STEPS[step].ms);
    return () => clearTimeout(timer);
  }, [step]);

  const complete = done || step >= STEPS.length - 1;

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="relative grid h-20 w-20 place-items-center">
        <span
          aria-hidden
          className={`absolute inset-0 rounded-full border-2 ${
            done ? "border-ok/30" : "border-accent/30"
          } ${done ? "" : "animate-ping"}`}
          style={{ animationDuration: "2s" }}
        />
        <span
          aria-hidden
          className={`absolute inset-2 rounded-full border-2 ${done ? "border-ok/40" : "border-accent/40"} ${
            done ? "" : "animate-ping"
          }`}
          style={{ animationDuration: "2s", animationDelay: "0.4s" }}
        />
        <span
          aria-hidden
          className={`relative grid h-11 w-11 place-items-center rounded-full ${
            done ? "bg-ok" : "bg-accent"
          } text-white transition-colors`}
        >
          {done ? (
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M5 10.5l3.5 3.5L15 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          )}
        </span>
      </div>

      <h1 className="display mt-6 text-[24px] text-fg" role="status">
        {done ? "All done" : "Wrapping up"}
      </h1>
      <p className="mt-1.5 max-w-sm text-[14px] text-fg-2">
        {removed
          ? "The interview ended early. A person reviews everything that was recorded before this point."
          : done
            ? "Someone from the team reviews the conversation and decides what happens next. Nothing was decided automatically."
            : "Your answers are being saved. This takes a moment."}
      </p>

      {!done && (
        <ul className="mt-6 space-y-2 text-left">
          {STEPS.map((s, i) => (
            <li key={s.label} className="flex items-center gap-2.5 text-[13px]">
              <span
                aria-hidden
                className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                  i < step
                    ? "border-ok bg-ok text-white"
                    : i === step
                      ? "border-accent"
                      : "border-border"
                }`}
              >
                {i < step ? (
                  <svg viewBox="0 0 20 20" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M5 10.5l3.5 3.5L15 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : i === step ? (
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                ) : null}
              </span>
              <span className={i <= step ? "text-fg" : "text-fg-3"}>{s.label}</span>
            </li>
          ))}
        </ul>
      )}

      {!complete && (
        <div className="mt-6 h-0.5 w-48 overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full bg-accent transition-[width] duration-700"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
