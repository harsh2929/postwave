/**
 * SSENewEventsPill — sse-pinned-tail feature.
 *
 * Floating "+N new events ↑" pill (Slack pattern). When the user has
 * scrolled past the top of the list, new SSE events are buffered
 * rather than prepended in-place — otherwise the operator's reading
 * position jumps every time a row arrives. Clicking the pill or
 * scrolling back to the top flushes the buffer.
 *
 * Pure presentation; the parent owns the buffer state.
 */

import type { ReactElement } from "react";

interface Props {
  count: number;
  onClick: () => void;
  /** Optional label override — defaults to "new event(s)". */
  label?: string;
}

export function SSENewEventsPill({
  count,
  onClick,
  label,
}: Props): ReactElement | null {
  if (count <= 0) return null;
  const noun = label ?? (count === 1 ? "new event" : "new events");
  return (
    <button
      type="button"
      className="sse-new-events-pill"
      onClick={onClick}
      data-testid="sse-new-events-pill"
      aria-label="Show events that arrived while this view was open"
      style={{
        position: "sticky",
        top: 8,
        zIndex: 10,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        margin: "0 auto",
        borderRadius: 999,
        background: "var(--pw-accent)",
        color: "var(--pw-solid-fg)",
        border: "none",
        boxShadow:
          "0 4px 12px color-mix(in srgb, var(--pw-shadow-color) 18%, transparent)",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      <span aria-hidden="true">↑</span>
      <span>
        +{count} {noun}
      </span>
    </button>
  );
}
