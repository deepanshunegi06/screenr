"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

/* ------------------------------------------------------------------------ */
/* Shell                                                                     */
/* ------------------------------------------------------------------------ */

const NAV = [
  { href: "/", label: "Interviews", match: (p: string) => p === "/" || p.startsWith("/sessions") },
  { href: "/compare", label: "Compare", match: (p: string) => p.startsWith("/compare") },
  { href: "/roles", label: "Roles", match: (p: string) => p.startsWith("/roles") },
  { href: "/evals", label: "Evals", match: (p: string) => p.startsWith("/evals") },
];

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className="grid h-5 w-5 place-items-center rounded-[5px] bg-fg text-[10px] font-semibold text-surface"
      >
        s
      </span>
      {!compact && <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg">screenr</span>}
    </span>
  );
}

export function AppShell({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-[216px] shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="flex h-12 items-center px-4">
          <Link href="/" className="rounded-sm">
            <Logo />
          </Link>
        </div>
        <nav className="mt-1 flex flex-col gap-0.5 px-2" aria-label="Main">
          {NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-8 items-center rounded-md px-2.5 text-[13px] transition-colors ${
                  active ? "bg-surface-2 font-medium text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto border-t border-border p-3">{right}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
          <Logo />
          {right}
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  crumbs,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  crumbs?: { href?: string; label: string }[];
}) {
  return (
    <div className="border-b border-border bg-surface px-6 py-4">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1.5 flex items-center gap-1.5 text-[12px] text-fg-3">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden>/</span>}
              {c.href ? (
                <Link href={c.href} className="hover:text-fg">
                  {c.label}
                </Link>
              ) : (
                <span className="text-fg-2">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-fg">{title}</h1>
          {description && <p className="mt-0.5 text-[13px] text-fg-2">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Page({ children, width = "default" }: { children: ReactNode; width?: "default" | "wide" | "narrow" }) {
  const max = { default: "max-w-[1080px]", wide: "max-w-[1400px]", narrow: "max-w-[720px]" }[width];
  return <div className={`mx-auto w-full ${max} px-6 py-6`}>{children}</div>;
}

/* ------------------------------------------------------------------------ */
/* Controls                                                                  */
/* ------------------------------------------------------------------------ */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
};

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-50 select-none";
const BUTTON_SIZE = { sm: "h-7 px-2.5 text-[12px]", md: "h-8 px-3 text-[13px]" };
const BUTTON_VARIANT = {
  primary: "bg-accent text-white hover:bg-accent-hover shadow-sm",
  secondary: "border border-border bg-surface text-fg hover:bg-surface-2 shadow-sm",
  ghost: "text-fg-2 hover:bg-surface-2 hover:text-fg",
  danger: "border border-border bg-surface text-bad hover:bg-bad-soft shadow-sm",
};

export function Button({ variant = "secondary", size = "md", loading, children, className = "", ...rest }: ButtonProps) {
  return (
    <button
      className={`${BUTTON_BASE} ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${className}`}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent ${className}`}
    />
  );
}

export const inputClass =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg shadow-sm " +
  "placeholder:text-fg-4 hover:border-border-strong focus:border-accent focus:outline-none " +
  "disabled:bg-surface-2 disabled:text-fg-3";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`${inputClass} h-auto min-h-[88px] resize-y py-2 leading-relaxed ${props.className ?? ""}`}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[12px] font-medium text-fg-2">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1.5 text-[12px] text-bad">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-[12px] text-fg-3">{hint}</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Display                                                                   */
/* ------------------------------------------------------------------------ */

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";

const BADGE_TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-2 border-border",
  accent: "bg-accent-soft text-accent-fg border-transparent",
  ok: "bg-ok-soft text-ok-fg border-transparent",
  warn: "bg-warn-soft text-warn-fg border-transparent",
  bad: "bg-bad-soft text-bad-fg border-transparent",
};

export function Badge({ tone = "neutral", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-[5px] border px-2 text-[12px] font-medium ${BADGE_TONE[tone]}`}
    >
      {dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

export function Verdict({ value }: { value: "advance" | "another_round" | "below_bar" | "inconclusive" }) {
  // Inconclusive is neutral on purpose: it means "not enough evidence", not
  // "bad". Red is reserved for a human's recorded rejection.
  const map = {
    advance: { tone: "ok" as Tone, label: "Advance" },
    another_round: { tone: "warn" as Tone, label: "Another round" },
    below_bar: { tone: "bad" as Tone, label: "Below bar" },
    inconclusive: { tone: "neutral" as Tone, label: "Inconclusive" },
  }[value];
  return (
    <Badge tone={map.tone} dot>
      {map.label}
    </Badge>
  );
}

export function Card({ children, className = "", padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <div className={`rounded-lg border border-border bg-surface shadow-sm ${padded ? "p-4" : ""} ${className}`}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-[13px] font-semibold text-fg">{children}</h2>
      {aside && <span className="text-[12px] text-fg-3">{aside}</span>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  const color = tone ? { neutral: "text-fg", accent: "text-accent", ok: "text-ok", warn: "text-warn", bad: "text-bad" }[tone] : "text-fg";
  return (
    <div className="rounded-lg border border-border bg-surface p-3 shadow-sm">
      <div className="text-[12px] text-fg-3">{label}</div>
      <div className={`tnum mt-1 text-[20px] font-semibold leading-none tracking-[-0.01em] ${color}`}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] text-fg-3">{sub}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
      <p className="text-[14px] font-medium text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-fg-2">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-border bg-surface-2 px-1 font-mono text-[11px] text-fg-2">
      {children}
    </kbd>
  );
}

/* ------------------------------------------------------------------------ */
/* Table                                                                     */
/* ------------------------------------------------------------------------ */

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    // overflow-x-auto, not hidden: a wide table should scroll rather than silently
    // clip its last columns on a narrow screen.
    <div className={`overflow-x-auto rounded-lg border border-border bg-surface shadow-sm ${className}`}>
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  );
}

export function Th({ children, className = "", align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={`h-9 border-b border-border bg-surface-2/60 px-3 text-[12px] font-medium text-fg-3 ${
        align === "right" ? "text-right" : "text-left"
      } ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = "", align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" }) {
  return (
    <td className={`h-11 border-b border-border px-3 align-middle last:border-b-0 ${align === "right" ? "text-right" : ""} ${className}`}>
      {children}
    </td>
  );
}

/* ------------------------------------------------------------------------ */
/* Toast (minimal, no dependency)                                            */
/* ------------------------------------------------------------------------ */

export function Toast({ message, tone = "neutral" }: { message: string; tone?: Tone }) {
  const bar = { neutral: "bg-fg", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" }[tone];
  return (
    <div
      role="status"
      className="pointer-events-auto flex items-stretch overflow-hidden rounded-md border border-border bg-surface text-[13px] text-fg shadow-lg"
    >
      <span aria-hidden className={`w-1 ${bar}`} />
      <span className="px-3 py-2">{message}</span>
    </div>
  );
}
