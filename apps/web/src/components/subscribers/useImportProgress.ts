// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";

import {
  subscribeImportProgress,
  type ImportProgressFrame,
} from "@/lib/live-streams-api";
import {
  getImport,
  isTerminalImportStatus,
  type ImportState,
} from "@/lib/subscriber-imports-api";

export type ImportProgressSource = "stream" | "poll";

export interface ImportProgress {
  /** Latest known state; a stream frame is folded onto the last full read. */
  state: ImportState | null;
  /** Whether the numbers arrive over SSE or the 1.5 s poll fallback. */
  source: ImportProgressSource;
  /** True once the import reached a terminal status and the final read landed. */
  done: boolean;
}

const POLL_INTERVAL_MS = 1500;

/**
 * Follows a running CSV import to its terminal status, the way desktop does:
 * over GET /api/v1/subscriber-imports/{id}/progress (server-sent events) when
 * the browser can open one, otherwise by polling GET /api/v1/subscriber-imports/{id}.
 *
 * The stream carries counts only, so when it reports a terminal status the
 * hook makes ONE full read to pick up `dry_run_results`, `error` and the
 * rest before reporting `done`. If the server closes the stream early
 * (`event: closed`) the hook falls back to polling rather than stalling.
 */
export function useImportProgress(
  importId: string | null,
  active: boolean,
): ImportProgress {
  const [state, setState] = useState<ImportState | null>(null);
  const [source, setSource] = useState<ImportProgressSource>("poll");
  const [done, setDone] = useState(false);
  const stateRef = useRef<ImportState | null>(null);

  useEffect(() => {
    if (!active || !importId) return;
    let live = true;
    let polling = false;
    let pollTimer: number | null = null;
    let finishing = false;
    setDone(false);

    const publish = (next: ImportState) => {
      stateRef.current = next;
      setState(next);
    };

    const finish = async () => {
      if (finishing) return;
      finishing = true;
      try {
        const full = await getImport(importId);
        if (!live) return;
        publish(full);
      } catch {
        /* the stream's terminal frame already told us the outcome */
      }
      if (live) setDone(true);
    };

    const tick = async () => {
      if (!live) return;
      try {
        const next = await getImport(importId);
        if (!live) return;
        publish(next);
        if (isTerminalImportStatus(next.status)) {
          setDone(true);
          return;
        }
      } catch {
        /* transient poll error — keep trying */
      }
      if (live)
        pollTimer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    const startPolling = () => {
      if (polling || !live) return;
      polling = true;
      setSource("poll");
      void tick();
    };

    const stop = subscribeImportProgress(importId, {
      onStatus: (status) => {
        if (!live) return;
        if (status === "open") {
          setSource("stream");
        } else if (status === "closed" && !polling && !finishing) {
          // No SSE in this environment (or the server hung up): poll instead.
          startPolling();
        }
      },
      onProgress: (frame: ImportProgressFrame) => {
        if (!live) return;
        const base = stateRef.current;
        publish({
          ...(base ?? { id: importId, configuration_revision: 0 }),
          id: importId,
          status: frame.status,
          processed_rows: frame.processed_rows,
          rows_total: frame.total_rows,
          rows_imported: frame.rows_imported,
          rows_skipped: frame.rows_skipped,
          rows_failed: frame.rows_failed,
        } as ImportState);
        if (isTerminalImportStatus(frame.status)) void finish();
      },
      onClosed: () => {
        if (live && !finishing) startPolling();
      },
    });

    return () => {
      live = false;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      stop();
    };
  }, [importId, active]);

  return { state, source, done };
}
