// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * QueueTrayLauncher — the header affordance that makes the offline queue
 * reachable WHILE ONLINE (SHELL-019). Previously the tray could only be opened
 * from the offline-only banner, so a user told on reconnect that they had
 * conflicts/failed replays had no way to open it until a reload (which discards
 * the queue). This mounts the single dashboard QueueTray, shows a header button
 * whenever items need attention (or are pending while online), and also opens
 * on the `pw:open-queue-tray` event — dispatched by the offline banner and the
 * reconnect toast's "Review" action.
 */

import { useEffect, useId, useState } from "react";
import { RefreshCw } from "lucide-react";

import { useOnline } from "@/lib/use-online";
import { useOutbox } from "@/lib/outbox";
import { QueueTray } from "./queue-tray";

export const OPEN_QUEUE_TRAY_EVENT = "pw:open-queue-tray";

export function QueueTrayLauncher() {
  const outbox = useOutbox();
  const conn = useOnline();
  const trayId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = (): void => setOpen(true);
    window.addEventListener(OPEN_QUEUE_TRAY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_QUEUE_TRAY_EVENT, onOpen);
  }, []);

  const attention = outbox.attentionCount;
  const pending = outbox.pendingCount;
  // The offline banner already surfaces pending items while OFFLINE. The header
  // affordance covers what the banner can't: anything needing attention, and
  // pending items once back online (mid-replay).
  const visible = attention > 0 || (pending > 0 && conn === "online");
  const count = attention > 0 ? attention : pending;
  const danger = attention > 0;

  return (
    <>
      {visible ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={
            danger
              ? `Offline queue — ${attention} ${attention === 1 ? "item needs" : "items need"} attention`
              : `Offline queue — ${pending} syncing`
          }
          title="Offline queue"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={trayId}
          className="relative inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          <span
            className={`absolute right-0.5 top-0.5 min-w-4 rounded-full px-1 text-[10px] leading-4 ${
              danger
                ? "bg-destructive text-destructive-foreground"
                : "bg-primary text-primary-foreground"
            }`}
          >
            {count > 99 ? "99+" : count}
          </span>
        </button>
      ) : null}
      <QueueTray open={open} onClose={() => setOpen(false)} panelId={trayId} />
    </>
  );
}
