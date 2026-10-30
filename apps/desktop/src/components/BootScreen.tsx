/**
 * Boot screen — the first thing users see while we resolve the dashboard URL
 * and prepare to redirect. Branded but minimal: a Moosewave wordmark with a
 * subtle pulse animation. No external assets.
 */

import type { CSSProperties, ReactElement } from "react";

/**
 * A barely-there seasonal wink on the boot wordmark: a soft ember→gold
 * gradient in December, the year-round ink default otherwise. Pure +
 * month-gated so the default is the normal look and the variant is testable
 * without waiting for the season. Inline-only (never touches styles.css), and
 * falls back to a solid festive ember where background-clip:text is
 * unsupported so the wordmark can never render invisible.
 */
export function seasonalWordmarkStyle(
  date: Date = new Date(),
): CSSProperties | undefined {
  if (date.getMonth() !== 11) return undefined; // 11 = December
  const canClip =
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("-webkit-background-clip", "text");
  if (!canClip) return { color: "#C8102E" };
  return {
    backgroundImage: "linear-gradient(90deg, #C8102E, #F2B233)",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
  };
}

export function BootScreen(): ReactElement {
  return (
    <div className="pw-screen" role="status" aria-live="polite">
      <div className="pw-wordmark pw-pulse" style={seasonalWordmarkStyle()}>
        postwave
      </div>
      <p>Starting up…</p>
    </div>
  );
}
