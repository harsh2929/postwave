// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * OfflinePendingLink — small client-only block on /offline that shows
 * "Pending changes (N)" and opens the QueueTray, so users can inspect
 * what will replay on reconnect without leaving the page.
 */

import { useState } from "react";

import { useOutbox } from "@/lib/outbox";
import { QueueTray } from "./queue-tray";

export function OfflinePendingLink() {
  const outbox = useOutbox();
  const [open, setOpen] = useState(false);

  if (outbox.pendingCount === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="mt-4 inline-flex min-h-11 w-fit items-center gap-2 rounded-md border border-warning-emphasis/40 bg-warning-subtle px-3 py-2 text-sm font-medium text-warning-emphasis hover:bg-warning-subtle/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span
          aria-hidden="true"
          className="inline-block size-2.5 rounded-full bg-warning-emphasis/80"
        />
        Pending changes ({outbox.pendingCount})
      </button>
      <QueueTray open={open} onClose={() => setOpen(false)} />
    </>
  );
}
