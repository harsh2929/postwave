/**
 * useQueuedWriteDetails — the offline queue as REQUESTS, with the three verbs
 * desktop's QueueTray has and mobile lacked (parity register, shell-crosscutting
 * "offline outbox depth" + P2.56):
 *
 *   - re-issue with an edited body (QueuedMutationEditor → updateOfflineMutation),
 *   - retry a failed write as-is,
 *   - restore a discarded write (the Undo on the discard toast).
 *
 * Everything that can be wrong is decided in lib/queuedWriteDetail (pure,
 * node-tested against a real QueryClient); this hook only binds the singleton
 * client, the persister's `offlineSafe` meta and a freshly minted identity.
 * Same identity rules as OfflineQueueSection: `currentOfflineAuthScope` throws
 * for an incomplete identity, which reads as "nothing to show", never as
 * another person's queue.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OfflineMutationAuthScope } from "@/lib/offlineMutationContract";
import { currentOfflineAuthScope } from "@/lib/offlineMutations";
import { offlineSafeMutationMeta, queryClient } from "@/lib/queryClient";
import {
  discardQueuedWrite,
  listQueuedWriteDetails,
  rebuildQueuedVariables,
  reissueQueuedWrite,
  type QueuedWriteDetail,
  type ReissuedWrite,
} from "@/lib/queuedWriteDetail";

export type QueuedWriteReissue =
  | { ok: true; reissued: ReissuedWrite }
  | { ok: false; error: string };

export interface QueuedWriteDetails {
  details: QueuedWriteDetail[];
  detailFor: (operationId: string) => QueuedWriteDetail | null;
  /** Replace the write with one carrying `body`; refuses what replay would refuse. */
  reissue: (detail: QueuedWriteDetail, body: unknown) => QueuedWriteReissue;
  /** Send the same body again with a fresh two-hour window. */
  retry: (detail: QueuedWriteDetail) => QueuedWriteReissue;
  /** Undo a discard: put the write back exactly as it was. */
  restore: (detail: QueuedWriteDetail) => QueuedWriteReissue;
  /** Drop a queued or failed write; false when it is on the wire. */
  discard: (detail: QueuedWriteDetail) => boolean;
  refresh: () => void;
}

function scopeOrNull(): OfflineMutationAuthScope | null {
  try {
    return currentOfflineAuthScope();
  } catch {
    return null;
  }
}

export function useQueuedWriteDetails(): QueuedWriteDetails {
  const [details, setDetails] = useState<QueuedWriteDetail[]>([]);
  const live = useRef(true);

  const refresh = useCallback(() => {
    const scope = scopeOrNull();
    setDetails(scope ? listQueuedWriteDetails(queryClient, scope) : []);
  }, []);

  useEffect(() => {
    live.current = true;
    // The first read is safe synchronously; the cache notifies from inside the
    // mutating component's render, so the subscription defers (same fault and
    // fix as OfflineQueueSection).
    refresh();
    const deferred = () => {
      queueMicrotask(() => {
        if (live.current) refresh();
      });
    };
    const stop = queryClient.getMutationCache().subscribe(deferred);
    return () => {
      live.current = false;
      stop();
    };
  }, [refresh]);

  const detailFor = useCallback(
    (operationId: string) =>
      details.find((detail) => detail.operationId === operationId) ?? null,
    [details],
  );

  const reissue = useCallback(
    (detail: QueuedWriteDetail, body: unknown): QueuedWriteReissue => {
      const scope = scopeOrNull();
      if (!scope) return { ok: false, error: "Signed-in identity changed." };
      const rebuilt = rebuildQueuedVariables(detail, body, scope);
      if (!rebuilt.ok) return rebuilt;
      const reissued = reissueQueuedWrite(
        queryClient,
        detail,
        rebuilt.variables,
        { ...offlineSafeMutationMeta },
      );
      return { ok: true, reissued };
    },
    [],
  );

  const retry = useCallback(
    (detail: QueuedWriteDetail): QueuedWriteReissue => {
      if (detail.editable) return reissue(detail, detail.body);
      // A sequence save is never rebuilt (the builder owns the step list), but
      // sending the same snapshot again is exactly what "retry" means.
      const scope = scopeOrNull();
      if (!scope) return { ok: false, error: "Signed-in identity changed." };
      const reissued = reissueQueuedWrite(
        queryClient,
        detail,
        { ...detail.variables, auth: scope },
        { ...offlineSafeMutationMeta },
      );
      return { ok: true, reissued };
    },
    [reissue],
  );

  const restore = useCallback((detail: QueuedWriteDetail): QueuedWriteReissue => {
    // Verbatim, including the original window: an undo puts back what was
    // there, and an expired write fails visibly at replay rather than being
    // quietly granted two more hours.
    const reissued = reissueQueuedWrite(queryClient, detail, detail.variables, {
      ...offlineSafeMutationMeta,
    });
    return { ok: true, reissued };
  }, []);

  const discard = useCallback(
    (detail: QueuedWriteDetail) => discardQueuedWrite(queryClient, detail),
    [],
  );

  return useMemo(
    () => ({ details, detailFor, reissue, retry, restore, discard, refresh }),
    [details, detailFor, reissue, retry, restore, discard, refresh],
  );
}
