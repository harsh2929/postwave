/**
 * LiveDot — small green pulsing dot + label that signals an active SSE
 * stream. Used in stat cards, the Dashboard header, and the Campaign
 * detail Performance section.
 *
 * Visual states:
 *   - "open"          → solid green dot pulsing softly + "Live"
 *   - "connecting"    → muted dot + "Connecting…"
 *   - "reconnecting"  → muted dot + "Reconnecting…" (no pulse)
 *   - "closed"        → renders nothing (caller controls mounting)
 */
import { type ReactElement } from "react";

import { type SseStatus } from "../lib/sse";

interface Props {
  status: SseStatus;
  /** Optional label override, defaults to "Live" when open. */
  label?: string;
}

export function LiveDot({ status, label }: Props): ReactElement | null {
  if (status === "closed") return null;
  const text =
    status === "open"
      ? label ?? "Live"
      : status === "reconnecting"
        ? "Reconnecting…"
        : "Connecting…";
  const cls = status === "open" ? "live-dot live-pulse" : "live-dot live-dot-muted";
  return (
    <span className="live-indicator" aria-live="polite">
      <span className={cls} aria-hidden="true" />
      <span className="live-label">{text}</span>
    </span>
  );
}
