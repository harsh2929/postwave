/**
 * TriggerFiredBadge — small chip showing "🔥 N fired · Xh ago" on
 * trigger rows. Refined Webhooks PR 2. Renders nothing when the
 * trigger has never fired (avoids implying it's broken).
 */

import { type ReactElement } from "react";

interface Props {
  firedCount: number;
  lastFiredAt: string | null | undefined;
}

function fmtRel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function TriggerFiredBadge({
  firedCount,
  lastFiredAt,
}: Props): ReactElement | null {
  if (firedCount === 0) {
    return (
      <span
        className="badge"
        style={{ fontSize: 10, opacity: 0.6 }}
        title="This trigger hasn't fired yet."
      >
        not fired
      </span>
    );
  }
  return (
    <span
      className="wh-trigger-fired"
      title={lastFiredAt ? `Last fired ${new Date(lastFiredAt).toLocaleString()}` : ""}
    >
      🔥 {firedCount.toLocaleString()}
      {lastFiredAt ? (
        <span className="muted" style={{ marginLeft: 4 }}>
          · {fmtRel(lastFiredAt)}
        </span>
      ) : null}
    </span>
  );
}
