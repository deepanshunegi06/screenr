# screenr — design system

This is a hiring tool. It should look like software a company runs its pipeline on,
not like a portfolio piece. Reference quality: Ashby, Linear, Greenhouse.

## Principles

1. **Dense and functional.** 13px table text, 14px body, 12px meta. Tight vertical rhythm.
   Whitespace is for grouping, not for mood.
2. **Sans everywhere.** IBM Plex Sans for UI, IBM Plex Mono only for identifiers, timestamps,
   tool names, and code. No serif. No display faces.
3. **One accent.** Blue `--color-accent` for the primary action and active nav. Everything
   else neutral. Semantic green/amber/red only for verdicts and status.
4. **Copy is functional.** Sentence case. Verb-first buttons ("Invite candidate", "Advance").
   No marketing lines, no poetry, no exclamation marks. Say what it does.
5. **Every state exists.** Loading (skeletons, not spinners on whole pages), empty (with the
   next action), error (what happened + what to do), success (inline, not modal).
6. **Structure encodes meaning.** A badge means status. A left border means a quote.
   Mono means machine-readable. Never decorative.

## Do not use

- Uppercase mono "eyebrow" labels. Use a 12px medium-weight sentence-case label instead.
- Hairline rules as the primary layout device. Use bordered cards and tables.
- Serif type anywhere.
- Rounded-full pills for status. Badges are 5px radius.
- Hero sections, taglines, or explanatory prose blocks on app screens.
- Gradients, glows, blur, glassmorphism.
- Emoji.

## Tokens

All in `web/app/globals.css` under `@theme`. Use Tailwind utilities that map to them:
`bg-surface`, `text-fg-2`, `border-border`, `bg-accent`, `text-ok`, `bg-warn-soft`, etc.
Radii: `rounded-sm` (4) controls inside controls, `rounded-md` (6) controls, `rounded-lg` (10) cards.
Shadows: `shadow-sm` on cards and controls, `shadow-md` on popovers, `shadow-lg` on toasts/dialogs.

## Primitives — `web/components/ui.tsx`

Use these. Do not restyle them per screen. If one is missing, add it there.

- `AppShell` — sidebar (Interviews / Roles / Evals) + main. Wrap every recruiter page.
- `PageHeader` — title, optional description, optional breadcrumbs, right-side actions.
- `Page` — content container. `width="wide"` for tables, `"narrow"` for forms.
- `Button` — `primary | secondary | ghost | danger`, `sm | md`, `loading`.
- `Input`, `Textarea`, `Field` — forms. Field carries label, hint, error.
- `Badge` — `neutral | accent | ok | warn | bad`, optional dot.
- `Verdict` — the recommendation badge. Never render a recommendation any other way.
- `Card`, `SectionTitle`, `Stat` — grouping and numbers.
- `Table`, `Th`, `Td` — data tables. Rows are `h-11`. Hover `bg-surface-2`.
- `EmptyState`, `Skeleton`, `Spinner`, `Kbd`, `Toast`.

## Layouts

**Recruiter pages** — `AppShell` > `PageHeader` > `Page`. Tables full-width.

**Scorecard** — two columns on desktop: main (evidence, coverage, transcript) and a
sticky 300px right rail (verdict, decision buttons, candidate facts, cost, integrity).
On mobile the rail stacks above the main column.

**Candidate room** — no sidebar. Centered column, max 720px. Minimal header with logo,
status, and elapsed time. Transcript grows downward; controls stick to the bottom.

## Voice of the product

- Buttons: "Invite candidate", "Create link", "Copy link", "Advance", "Another round",
  "Reject", "Start interview", "Type instead".
- Statuses: "Not started", "In progress", "Finished", "Reviewed".
- Errors: "Couldn't reach the server. Retry." — what happened, then what to do.
- Empty: "No interviews yet" + the button that creates one.
- Candidate-facing: plain, calm, second person. Never mention scores.
