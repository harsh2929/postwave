/**
 * ListHealthBadge — small letter-grade pill (A–F) that summarises a
 * list's deliverability + engagement profile in one glanceable token.
 *
 * Two visual states:
 *   • Loaded    — grade A/B/C/D/F + score number on hover
 *   • Loading   — pulsing placeholder (matches the rest of the page's
 *                 skel pattern, not a spinner)
 *
 * The score → grade mapping is the backend's responsibility (see
 * apps/api/internal/list_health). We never recompute it client-side
 * so the desktop's display matches the API's own thresholds.
 */

import type { ReactElement } from "react";

import type { ListHealthResult } from "../../lib/api-client";

interface Props {
  /** undefined = still loading; null = failed / unavailable. */
  health: ListHealthResult | null | undefined;
}

function colorFor(grade: string | undefined): string {
  const g = (grade ?? "").toUpperCase()[0];
  if (g === "A") return "var(--pw-accent)";
  if (g === "B") return "color-mix(in srgb, var(--pw-accent) 70%, var(--pw-warning))";
  if (g === "C") return "var(--pw-warning)";
  if (g === "D") return "color-mix(in srgb, var(--pw-warning) 60%, var(--pw-danger))";
  return "var(--pw-danger)"; // F
}

export function ListHealthBadge({ health }: Props): ReactElement {
  if (health === undefined) {
    return (
      <span
        className="skel"
        style={{
          display: "inline-block",
          width: 22,
          height: 16,
          borderRadius: 4,
          verticalAlign: "middle",
        }}
        aria-label="Loading health"
      />
    );
  }
  if (health === null) {
    return (
      <span
        title="No health data — list has no recent activity"
        style={{
          fontSize: 11,
          color: "var(--pw-fg-subtle)",
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        }}
      >
        —
      </span>
    );
  }
  const color = colorFor(health.grade);
  return (
    <span
      title={
        `Score ${health.score ?? 0}/100\n` +
        `Engagement: ${((health.engagement_rate ?? 0) * 100).toFixed(1)}%\n` +
        `Bounce: ${((health.bounce_rate ?? 0) * 100).toFixed(2)}%\n` +
        `Complaint: ${((health.complaint_rate ?? 0) * 100).toFixed(2)}%\n` +
        `Unsubscribe: ${((health.unsubscribe_rate ?? 0) * 100).toFixed(2)}%`
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 999,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        color,
        fontSize: 11,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
        cursor: "help",
      }}
    >
      {health.grade ?? "?"}
      <span
        style={{
          fontSize: 10,
          color: "var(--pw-fg-muted)",
          fontWeight: 500,
        }}
      >
        {health.score}
      </span>
    </span>
  );
}
