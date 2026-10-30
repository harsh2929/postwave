/**
 * DomainReputationBadge — small pill showing the 0–100 score + grade.
 *
 * Grades come straight from the backend (`Excellent | Good | Fair |
 * Poor | Critical`) so the UI never disagrees with the scoring API.
 * Tooltip surfaces the underlying rates (bounce, complaint, DMARC) so
 * the operator can see *why* a score is what it is without clicking
 * through.
 */

import type { ReactElement } from "react";

import type { SenderReputationDomain } from "../../lib/api-client";

interface Props {
  /** undefined = still loading; null = no reputation data for this domain. */
  rep: SenderReputationDomain | null | undefined;
}

function colorFor(grade: string): string {
  const g = grade.toLowerCase();
  if (g === "excellent") return "var(--pw-accent)";
  if (g === "good")
    return "color-mix(in srgb, var(--pw-accent) 70%, var(--pw-warning))";
  if (g === "fair") return "var(--pw-warning)";
  if (g === "poor")
    return "color-mix(in srgb, var(--pw-warning) 60%, var(--pw-danger))";
  if (g === "critical") return "var(--pw-danger)";
  return "var(--pw-fg-muted)";
}

export function DomainReputationBadge({ rep }: Props): ReactElement {
  if (rep === undefined) {
    return (
      <span
        className="skel"
        style={{
          display: "inline-block",
          width: 56,
          height: 16,
          borderRadius: 999,
          verticalAlign: "middle",
        }}
        aria-label="Loading reputation"
      />
    );
  }
  if (rep === null) {
    return (
      <span
        title="No sends in the last 7 days — reputation not scored yet"
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
  const color = colorFor(rep.grade);
  return (
    <span
      title={
        `Score ${rep.score}/100 — ${rep.grade}\n` +
        `Sends (7d): ${rep.sends_last_7d.toLocaleString()}\n` +
        // Backend already emits these as percents (sender_reputation.go
        // computes bounces/sends*100), so display verbatim — the old *100
        // rendered e.g. "DMARC pass: 10000.0%".
        `Bounce: ${rep.bounce_rate.toFixed(2)}%\n` +
        `Complaint: ${rep.complaint_rate.toFixed(2)}%\n` +
        `DMARC pass: ${rep.dmarc_pass_rate.toFixed(1)}%\n` +
        (rep.blocklist_hits > 0
          ? `Blocklist hits: ${rep.blocklist_hits}`
          : "")
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
      {rep.score}
      <span
        style={{
          fontSize: 10,
          color: "var(--pw-fg-muted)",
          fontWeight: 500,
        }}
      >
        {rep.grade.slice(0, 4)}
      </span>
    </span>
  );
}
