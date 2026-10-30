/**
 * LiveSubsChip — TopBar chip showing the workspace's current
 * subscriber count and last delta. Reads from the shared store
 * slice populated by the Dashboard page.
 *
 * Renders nothing until the dashboard has been visited at least once
 * (avoids a confusing "0 subs" flash before /me + /stats resolve).
 * Click navigates to the Dashboard.
 */

import { type ReactElement } from "react";

import { setSection, useLiveSubs } from "../../lib/store";

export function LiveSubsChip(): ReactElement | null {
  const liveSubs = useLiveSubs();
  if (!liveSubs) return null;
  const totalLabel = liveSubs.total.toLocaleString();
  const deltaLabel =
    liveSubs.added > 0
      ? `+${liveSubs.added.toLocaleString()}`
      : liveSubs.added < 0
        ? liveSubs.added.toLocaleString()
        : null;
  return (
    <button
      type="button"
      className="topbar-livesubs"
      onClick={() => setSection("dashboard")}
      aria-label={`Open dashboard; ${totalLabel} subscribers${deltaLabel ? `, ${deltaLabel} in the current window` : ""}`}
    >
      <span className="topbar-livesubs-dot" aria-hidden />
      <span className="topbar-livesubs-value tabular">{totalLabel}</span>
      {deltaLabel ? (
        <span
          className={`topbar-livesubs-delta ${
            liveSubs.added > 0 ? "up" : "down"
          }`}
        >
          {deltaLabel}
        </span>
      ) : null}
    </button>
  );
}
