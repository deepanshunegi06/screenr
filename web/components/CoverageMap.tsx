"use client";

import type { IntegrityFlag, SkillResult } from "@/lib/api";
import { mmss } from "@/lib/api";

/**
 * Skills down, interview time across. Every mark is one recorded piece of
 * evidence, placed at the moment it was recorded.
 *
 * An average hides two different failures: a skill nobody asked about, and a
 * skill asked about once in the first minute. Both are visible here and neither
 * is visible in a number.
 */

const LANE = 28;
const LABEL_W = 170;
const TRACK_W = 440;
const PAD_R = 12;

function markColor(score: number) {
  if (score >= 4) return "var(--color-ok)";
  if (score >= 3) return "var(--color-fg-2)";
  return "var(--color-warn)";
}

export function CoverageMap({
  skills,
  integrity,
  durationSeconds,
  onSelect,
}: {
  skills: SkillResult[];
  integrity: IntegrityFlag[];
  durationSeconds: number;
  onSelect?: (skillKey: string, index: number) => void;
}) {
  const span = Math.max(durationSeconds, 60);
  const lanes = skills.length + (integrity.length ? 1 : 0);
  const height = lanes * LANE + 26;
  const width = LABEL_W + TRACK_W + PAD_R;
  const x = (at: number) => LABEL_W + (Math.min(at, span) / span) * TRACK_W;

  const minutes = Math.floor(span / 60);
  const step = Math.max(1, Math.ceil(minutes / 6));
  const ticks = Array.from({ length: minutes + 1 }, (_, i) => i).filter((m) => m % step === 0);

  const uncovered = skills.filter((s) => !s.covered && !("cross_cutting" in s && (s as { cross_cutting?: boolean }).cross_cutting));

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="hidden w-full sm:block"
        role="img"
        aria-label={
          uncovered.length
            ? `Coverage map. ${uncovered.length} of ${skills.length} skills have no evidence: ${uncovered
                .map((s) => s.name)
                .join(", ")}.`
            : `Coverage map. All ${skills.length} skills have recorded evidence.`
        }
      >
        {skills.map((skill, row) => {
          const y = row * LANE + 14;
          return (
            <g key={skill.key}>
              <text
                x={LABEL_W - 12}
                y={y + 4}
                textAnchor="end"
                fill={skill.covered ? "var(--color-fg)" : "var(--color-fg-3)"}
                style={{ font: "400 12px var(--font-sans)" }}
              >
                {skill.name}
              </text>
              <line
                x1={LABEL_W}
                x2={LABEL_W + TRACK_W}
                y1={y}
                y2={y}
                stroke={skill.covered ? "var(--color-border-strong)" : "var(--color-border)"}
                strokeDasharray={skill.covered ? undefined : "2 5"}
              />
              {!skill.covered && (
                <text
                  x={LABEL_W + 10}
                  y={y + 4}
                  fill="var(--color-fg-3)"
                  style={{ font: "500 11px var(--font-sans)" }}
                >
                  Not asked
                </text>
              )}
              {skill.evidence.map((item, i) => (
                <g
                  key={i}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer"
                  onClick={() => onSelect?.(skill.key, i)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onSelect?.(skill.key, i);
                  }}
                >
                  <title>{`${skill.name} · ${item.score}/5 at ${mmss(item.at)}`}</title>
                  <rect x={x(item.at) - 6} y={y - 11} width={12} height={22} fill="transparent" />
                  <rect x={x(item.at) - 1.5} y={y - 8} width={3} height={16} rx={1.5} fill={markColor(item.score)} />
                </g>
              ))}
            </g>
          );
        })}

        {integrity.length > 0 && (
          <g>
            <text
              x={LABEL_W - 12}
              y={skills.length * LANE + 18}
              textAnchor="end"
              fill="var(--color-fg-3)"
              style={{ font: "400 12px var(--font-sans)" }}
            >
              Integrity
            </text>
            <line
              x1={LABEL_W}
              x2={LABEL_W + TRACK_W}
              y1={skills.length * LANE + 14}
              y2={skills.length * LANE + 14}
              stroke="var(--color-border)"
            />
            {integrity.map((f, i) => (
              <g key={i}>
                <title>{`${f.detail} at ${mmss(f.at)}`}</title>
                <circle cx={x(f.at)} cy={skills.length * LANE + 14} r={3.5} fill="var(--color-fg-3)" />
              </g>
            ))}
          </g>
        )}

        <line
          x1={LABEL_W}
          x2={LABEL_W + TRACK_W}
          y1={height - 16}
          y2={height - 16}
          stroke="var(--color-border)"
        />
        {ticks.map((m) => (
          <text
            key={m}
            x={x(m * 60)}
            y={height - 4}
            textAnchor="middle"
            fill="var(--color-fg-3)"
            style={{ font: "400 10px var(--font-mono)" }}
          >
            {m}m
          </text>
        ))}
      </svg>

      {/* Narrow screens: same information as a list. */}
      <ul className="divide-y divide-border sm:hidden">
        {skills.map((s) => (
          <li key={s.key} className="flex items-center justify-between py-2 text-[13px]">
            <span className={s.covered ? "text-fg" : "text-fg-3"}>{s.name}</span>
            <span className="text-fg-3">
              {s.covered
                ? `${s.evidence.length} mark${s.evidence.length === 1 ? "" : "s"} · first at ${mmss(s.evidence[0].at)}`
                : "Not asked"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
