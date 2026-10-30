/**
 * SubscribersNewBanner — SUB-095.
 *
 * Sticky floating "+N new subscribers ↑" pill at the top of the
 * subscriber list (the Slack "+N new messages" pattern). When the
 * operator has scrolled past the top of the list, newly-added
 * subscribers (delivered live via the `subscriber.added` SSE event) are
 * buffered rather than spliced into the page in-place — otherwise the
 * reading position would jump every time a row arrives. Clicking the
 * pill clears the identity buffer, refreshes the authoritative page, and
 * resets the count; scrolling back to the top does the same.
 *
 * Pure presentation — the parent (Subscribers.tsx) owns the buffer +
 * scroll state and the flush handler. Mirrors audit/SSENewEventsPill so
 * the two live-tail surfaces look and behave the same.
 */

import type { ReactElement } from "react";

interface Props {
  /** Number of buffered new subscribers since the operator scrolled down. */
  count: number;
  /** The bounded identity buffer reached its safety limit. */
  atLeast?: boolean;
  /** Refresh the authoritative page + scroll back to the top. */
  onClick: () => void;
}

export function SubscribersNewBanner({
  count,
  atLeast = false,
  onClick,
}: Props): ReactElement | null {
  if (count <= 0) return null;
  const noun = count === 1 ? "new subscriber" : "new subscribers";
  const exactCount = `${count.toLocaleString()}${atLeast ? " or more" : ""} ${noun}`;
  return (
    <button
      type="button"
      className="sse-new-events-pill"
      onClick={onClick}
      data-testid="subscribers-new-banner"
      aria-label={`Show ${exactCount} who joined since this view was opened`}
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
        color: "var(--pw-accent-fg)",
        border: "none",
        boxShadow:
          "0 4px 12px color-mix(in srgb, var(--pw-shadow-color) 30%, transparent)",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      <span aria-hidden="true">↑</span>
      <span>
        +{count.toLocaleString()}
        {atLeast ? " or more" : ""} {noun} since you opened this view
      </span>
    </button>
  );
}
