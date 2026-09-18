import type { SkillResult } from "@/lib/types";

/**
 * Skills down, interview time across. Every mark is one recorded piece of
 * evidence, placed at the moment it was recorded.
 *
 * An average hides two different failures: a skill nobody asked about, and a
 * skill asked about once in the first minute. Both are visible here and neither
 * is visible in a number.
 */

const LANE_HEIGHT = 30;
const LABEL_WIDTH = 168;
const TRACK_WIDTH = 420;
const PAD = 8;

function markColor(score: number) {
  if (score >= 4) return "var(--color-pine)";
  if (score >= 3) return "var(--color-ink-soft)";
  return "var(--color-amber)";
}

export function CoverageMap({
  skills,
  durationSeconds,
}: {
  skills: SkillResult[];
  durationSeconds: number;
}) {
  const height = skills.length * LANE_HEIGHT + 26;
  const width = LABEL_WIDTH + TRACK_WIDTH + PAD;
  const x = (at: number) => LABEL_WIDTH + (at / durationSeconds) * TRACK_WIDTH;
  const minutes = Math.floor(durationSeconds / 60);
  const ticks = Array.from({ length: minutes + 1 }, (_, i) => i).filter(
    (m) => m % Math.max(1, Math.ceil(minutes / 6)) === 0,
  );

  const uncovered = skills.filter((s) => !s.covered);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
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
          const y = row * LANE_HEIGHT + 14;
          return (
            <g key={skill.key}>
              <text
                x={LABEL_WIDTH - 12}
                y={y + 4}
                textAnchor="end"
                fill={skill.covered ? "var(--color-ink)" : "var(--color-amber)"}
                style={{ font: "400 13px var(--font-sans)" }}
              >
                {skill.name}
              </text>

              {skill.covered ? (
                <line
                  x1={LABEL_WIDTH}
                  x2={LABEL_WIDTH + TRACK_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="var(--color-rule)"
                  strokeWidth={1}
                />
              ) : (
                <line
                  x1={LABEL_WIDTH}
                  x2={LABEL_WIDTH + TRACK_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="var(--color-amber)"
                  strokeWidth={1}
                  strokeDasharray="2 5"
                  opacity={0.7}
                />
              )}

              {skill.evidence.map((item, i) => (
                <rect
                  key={i}
                  x={x(item.at) - 1.5}
                  y={y - 9}
                  width={3}
                  height={18}
                  rx={1.5}
                  fill={markColor(item.score)}
                />
              ))}

              {!skill.covered && (
                <text
                  x={LABEL_WIDTH + 10}
                  y={y + 4}
                  fill="var(--color-amber)"
                  style={{ font: "400 11px var(--font-mono)", letterSpacing: "0.06em" }}
                >
                  never asked
                </text>
              )}
            </g>
          );
        })}

        <line
          x1={LABEL_WIDTH}
          x2={LABEL_WIDTH + TRACK_WIDTH}
          y1={height - 18}
          y2={height - 18}
          stroke="var(--color-rule-soft)"
        />
        {ticks.map((m) => (
          <text
            key={m}
            x={x(m * 60)}
            y={height - 6}
            textAnchor="middle"
            fill="var(--color-faint)"
            style={{ font: "400 10px var(--font-mono)" }}
          >
            {m}m
          </text>
        ))}
      </svg>
    </figure>
  );
}
