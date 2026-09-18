import Link from "next/link";
import type { ReactNode } from "react";

/** The wordmark sets the register for the whole product: a document, not an app. */
export function Wordmark({ muted = false }: { muted?: boolean }) {
  return (
    <span
      className={`font-display text-[19px] tracking-tight ${muted ? "text-muted" : "text-ink"}`}
    >
      screenr
      <span className="text-pine">.</span>
    </span>
  );
}

export function Shell({
  children,
  right,
  back,
}: {
  children: ReactNode;
  right?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-rule bg-sheet">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <div className="flex items-baseline gap-4">
            <Link href="/">
              <Wordmark />
            </Link>
            {back && (
              <Link
                href={back.href}
                className="text-[13px] text-muted underline-offset-4 hover:text-ink hover:underline"
              >
                ← {back.label}
              </Link>
            )}
          </div>
          {right}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}

export function Verdict({
  recommendation,
  size = "sm",
}: {
  recommendation: "advance" | "another_round" | "inconclusive";
  size?: "sm" | "lg";
}) {
  const style = {
    advance: "bg-pine-soft text-pine",
    another_round: "bg-amber-soft text-amber",
    inconclusive: "bg-rust-soft text-rust",
  }[recommendation];
  const label = {
    advance: "Advance",
    another_round: "Another round",
    inconclusive: "Not enough evidence",
  }[recommendation];

  return (
    <span
      className={`inline-block rounded-full font-mono uppercase tracking-[0.1em] ${style} ${
        size === "lg" ? "px-4 py-1.5 text-[12px]" : "px-2.5 py-1 text-[10px]"
      }`}
    >
      {label}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="eyebrow block pb-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-rule bg-sheet px-3 py-2.5 text-[14px] text-ink " +
  "placeholder:text-faint focus:border-pine focus:outline-none";

export const buttonClass =
  "rounded-md bg-pine px-4 py-2.5 text-[13px] font-medium text-sheet " +
  "transition-opacity hover:opacity-90 disabled:opacity-40";

export const ghostButtonClass =
  "rounded-md border border-rule bg-sheet px-4 py-2.5 text-[13px] text-ink " +
  "transition-colors hover:border-ink-soft disabled:opacity-40";
