import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type SavedPreviewEntry,
  savedPreviewIsStale,
  validSavedSegmentPreview,
} from "../../components/subscribers/saved-segment-preview-state";
import {
  type SavedSegment,
  previewSavedSegmentDetail,
} from "../../lib/api-client";
import { remoteFailureFromError } from "../../lib/remote-resource";

const MAX_CONCURRENT_SAVED_PREVIEWS = 2;

interface PreviewTask {
  segmentId: string;
  generation: number;
}

export function useSavedSegmentPreviews(
  open: boolean,
  segments: SavedSegment[],
  identityScope: string | null,
) {
  const [previews, setPreviews] = useState<Record<string, SavedPreviewEntry>>(
    {},
  );
  const previewsRef = useRef(previews);
  const openRef = useRef(open);
  const identityRef = useRef(identityScope);
  const segmentIDsRef = useRef(new Set(segments.map(({ id }) => id)));
  const queueRef = useRef<PreviewTask[]>([]);
  const queuedRef = useRef(new Set<string>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const pumpRef = useRef<() => void>(() => undefined);

  previewsRef.current = previews;
  openRef.current = open;
  identityRef.current = identityScope;
  segmentIDsRef.current = new Set(segments.map(({ id }) => id));

  const segmentSignature = useMemo(
    () =>
      JSON.stringify(
        segments.map(({ id, updated_at }) => [id, updated_at] as const),
      ),
    [segments],
  );

  const replacePreviews = useCallback(
    (next: Record<string, SavedPreviewEntry>): void => {
      previewsRef.current = next;
      if (mountedRef.current) setPreviews(next);
    },
    [],
  );

  const cancelOwnedRequests = useCallback(
    (retainSettled: boolean): void => {
      generationRef.current += 1;
      queueRef.current = [];
      queuedRef.current.clear();
      for (const controller of controllersRef.current.values()) {
        controller.abort();
      }
      controllersRef.current.clear();
      if (retainSettled) {
        replacePreviews(
          Object.fromEntries(
            Object.entries(previewsRef.current).filter(
              ([, entry]) => entry.kind !== "loading",
            ),
          ),
        );
      }
    },
    [replacePreviews],
  );

  const pump = useCallback((): void => {
    if (!openRef.current || !identityRef.current) return;
    while (
      controllersRef.current.size < MAX_CONCURRENT_SAVED_PREVIEWS &&
      queueRef.current.length > 0
    ) {
      const task = queueRef.current.shift();
      if (!task) break;
      queuedRef.current.delete(task.segmentId);
      if (
        task.generation !== generationRef.current ||
        !segmentIDsRef.current.has(task.segmentId)
      ) {
        continue;
      }
      const controller = new AbortController();
      controllersRef.current.set(task.segmentId, controller);
      const ownerIdentity = identityRef.current;
      void previewSavedSegmentDetail(task.segmentId, {
        signal: controller.signal,
      })
        .then((response) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            task.generation !== generationRef.current ||
            ownerIdentity !== identityRef.current ||
            !segmentIDsRef.current.has(task.segmentId)
          ) {
            return;
          }
          let next: SavedPreviewEntry;
          if (response.error) {
            next =
              response.error.kind === "http" && response.error.status === 422
                ? { kind: "unevaluable" }
                : {
                    kind: "err",
                    failure: remoteFailureFromError(response.error),
                  };
          } else if (
            validSavedSegmentPreview(response.data) &&
            response.data.id === task.segmentId
          ) {
            next = {
              kind: "ok",
              preview: response.data,
              invalidated: false,
            };
          } else {
            next = {
              kind: "err",
              failure: remoteFailureFromError({
                kind: "parse",
                code: "invalid_saved_segment_preview",
              }),
            };
          }
          replacePreviews({
            ...previewsRef.current,
            [task.segmentId]: next,
          });
        })
        .catch(() => {
          if (
            mountedRef.current &&
            !controller.signal.aborted &&
            task.generation === generationRef.current &&
            ownerIdentity === identityRef.current
          ) {
            replacePreviews({
              ...previewsRef.current,
              [task.segmentId]: {
                kind: "err",
                failure: remoteFailureFromError({ kind: "network" }),
              },
            });
          }
        })
        .finally(() => {
          if (controllersRef.current.get(task.segmentId) === controller) {
            controllersRef.current.delete(task.segmentId);
          }
          pumpRef.current();
        });
    }
  }, [replacePreviews]);
  pumpRef.current = pump;

  const requestPreview = useCallback(
    (segmentId: string, force = false): void => {
      if (
        !openRef.current ||
        !identityRef.current ||
        !segmentIDsRef.current.has(segmentId) ||
        queuedRef.current.has(segmentId) ||
        controllersRef.current.has(segmentId)
      ) {
        return;
      }
      const existing = previewsRef.current[segmentId];
      if (
        !force &&
        existing &&
        (existing.kind !== "ok" || !savedPreviewIsStale(existing))
      ) {
        return;
      }
      const task = {
        segmentId,
        generation: generationRef.current,
      };
      queuedRef.current.add(segmentId);
      queueRef.current.push(task);
      replacePreviews({
        ...previewsRef.current,
        [segmentId]: { kind: "loading" },
      });
      pumpRef.current();
    },
    [replacePreviews],
  );

  const invalidatePreviewCounts = useCallback((): void => {
    cancelOwnedRequests(true);
    replacePreviews(
      Object.fromEntries(
        Object.entries(previewsRef.current).map(([id, entry]) => [
          id,
          entry.kind === "ok" ? { ...entry, invalidated: true } : entry,
        ]),
      ),
    );
  }, [cancelOwnedRequests, replacePreviews]);

  useEffect(() => {
    cancelOwnedRequests(false);
    replacePreviews({});
  }, [identityScope, cancelOwnedRequests, replacePreviews]);

  useEffect(() => {
    cancelOwnedRequests(true);
    const current = new Map(segments.map((segment) => [segment.id, segment]));
    const next = Object.fromEntries(
      Object.entries(previewsRef.current)
        .filter(([id]) => current.has(id))
        .map(([id, entry]) => {
          const segment = current.get(id);
          const changedAfterPreview =
            entry.kind === "ok" &&
            segment != null &&
            Date.parse(segment.updated_at) >
              Date.parse(entry.preview.generated_at);
          return [
            id,
            changedAfterPreview ? { ...entry, invalidated: true } : entry,
          ];
        }),
    );
    replacePreviews(next);
  }, [segmentSignature, cancelOwnedRequests, replacePreviews]);

  useEffect(() => {
    if (!open) cancelOwnedRequests(true);
  }, [open, cancelOwnedRequests]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      cancelOwnedRequests(false);
    },
    [cancelOwnedRequests],
  );

  return {
    previews,
    requestPreview,
    invalidatePreviewCounts,
  };
}

export type SubscribersSavedSegmentPreviews = ReturnType<
  typeof useSavedSegmentPreviews
>;
