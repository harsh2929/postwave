// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * OfflineBanner — top-of-app warning strip that appears only when we are
 * offline AND the outbox is non-empty. Clicking "View" opens the shared
 * QueueTray (owned by QueueTrayLauncher in the header, so the same tray is
 * reachable while online too — SHELL-019) via the pw:open-queue-tray event.
 *
 * Mounting once at the dashboard shell level keeps this banner orthogonal
 * to per-page layout — it sits above the topbar without colliding with
 * any route.
 *
 * Reconnect handling lives in PwaRegistrar; this banner only renders
 * the visible state.
 */

import { useOnline } from "@/lib/use-online";
import { useOutbox } from "@/lib/outbox";
import { OPEN_QUEUE_TRAY_EVENT } from "./queue-tray-launcher";

export function OfflineBanner() {
  const conn = useOnline();
  const outbox = useOutbox();

  const visible = conn === "offline" && outbox.pendingCount > 0;
  if (!visible) return null;

  return (
    <div
      className="flex items-start gap-3 border-b border-warning-emphasis/40 bg-warning-subtle px-3 py-2 text-sm font-medium text-warning-emphasis sm:items-center sm:px-4"
      role="status"
      aria-live="polite"
    >
      <span
        className="mt-4 size-2 shrink-0 rounded-full bg-warning-emphasis/80 shadow-[0_0_0_4px_hsl(var(--warning-emphasis)/0.18)] sm:mt-0"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 self-center break-words leading-5">
        You&rsquo;re offline — {outbox.pendingCount}{" "}
        {outbox.pendingCount === 1 ? "change" : "changes"} will sync when you
        reconnect. Keep this tab open; reloading discards the queue.
      </span>
      <button
        type="button"
        className="inline-flex min-h-11 shrink-0 items-center rounded-sm px-2 font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => window.dispatchEvent(new Event(OPEN_QUEUE_TRAY_EVENT))}
      >
        View &rarr;
      </button>
    </div>
  );
}
