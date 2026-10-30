/**
 * DomainHealthBadge — small pill that summarises a sending identity's
 * SPF/DKIM/DMARC verification state at a glance.
 *
 * Four states from the backend:
 *   • verified  — all three records green
 *   • partial   — some records pass, others fail
 *   • broken    — every record currently failing
 *   • pending   — never checked (or check still running)
 *
 * Tooltip surfaces the last-check timestamp and any error string the
 * recheck worker captured. Cheaper than rendering a 3-light traffic
 * panel inline; the slideover handles per-record breakdown.
 */

import type { ReactElement } from "react";

import type { DnsHealthStatus } from "../../lib/api-client";

interface Props {
  /** undefined = still loading; null = no health data for this domain. */
  status: DnsHealthStatus | null | undefined;
}

function colorFor(state: string): string {
  if (state === "verified") return "var(--pw-accent)";
  if (state === "partial") return "var(--pw-warning)";
  if (state === "broken") return "var(--pw-danger)";
  return "var(--pw-fg-muted)";
}

function labelFor(state: string): string {
  if (state === "verified") return "Verified";
  if (state === "partial") return "Partial";
  if (state === "broken") return "Broken";
  return "Pending";
}

function fmtRelTime(iso: string | undefined | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

export function DomainHealthBadge({ status }: Props): ReactElement {
  if (status === undefined) {
    return (
      <span
        className="skel"
        style={{
          display: "inline-block",
          width: 60,
          height: 16,
          borderRadius: 999,
          verticalAlign: "middle",
        }}
        aria-label="Loading health"
      />
    );
  }
  if (status === null) {
    return (
      <span
        title="Not tracked as a sending identity"
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
  const color = colorFor(status.verify_state);
  const label = labelFor(status.verify_state);
  return (
    <span
      title={
        `${label} (SPF / DKIM / DMARC)\n` +
        `Last checked: ${fmtRelTime(status.last_attempt_at)}\n` +
        (status.last_error ? `Last error: ${status.last_error}` : "")
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        color,
        fontSize: 11,
        fontWeight: 600,
        cursor: "help",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
        }}
      />
      {label}
    </span>
  );
}
