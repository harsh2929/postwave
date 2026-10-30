import { useCallback, useEffect, useRef, useState } from "react";

import { type SavedSegment, listSavedSegments } from "../../lib/api-client";
import { SAVED_SEGMENT_MAX_ITEMS } from "../../lib/api/audience-segmentation";
import { remoteFailureFromError } from "../../lib/remote-resource";
import { useSavedSegmentPreviews } from "./useSavedSegmentPreviews";

export function useSavedSegmentsLibrary(identityScope: string | null) {
  const mountedRef = useRef(true);
  const identityRef = useRef(identityScope);
  const loadGenerationRef = useRef(0);
  const loadOwnerRef = useRef<{
    identity: string;
    generation: number;
  } | null>(null);
  identityRef.current = identityScope;

  const [segments, setSegments] = useState<SavedSegment[]>([]);
  const [total, setTotal] = useState(0);
  const [maximum, setMaximum] = useState(SAVED_SEGMENT_MAX_ITEMS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const previews = useSavedSegmentPreviews(menuOpen, segments, identityScope);

  const invalidatePreviewCounts = useCallback((): void => {
    previews.invalidatePreviewCounts();
    // A locally known audience mutation invalidates both freshly requested
    // previews and denormalized counts returned by the list endpoint. Preserve
    // the last aggregate as context, but make its staleness explicit.
    setSegments((current) =>
      current.map((segment) =>
        segment.last_count != null && segment.last_evaluated_at
          ? { ...segment, last_evaluated_at: "1970-01-01T00:00:00.000Z" }
          : segment,
      ),
    );
  }, [previews.invalidatePreviewCounts]);

  const load = useCallback(
    async (options: { supersede?: boolean } = {}): Promise<void> => {
      const ownerIdentity = identityRef.current;
      if (!ownerIdentity) {
        loadGenerationRef.current += 1;
        loadOwnerRef.current = null;
        setSegments([]);
        setTotal(0);
        setLoading(false);
        setError(null);
        return;
      }
      if (
        loadOwnerRef.current?.identity === ownerIdentity &&
        !options.supersede
      ) {
        return;
      }
      const generation = ++loadGenerationRef.current;
      loadOwnerRef.current = { identity: ownerIdentity, generation };
      setLoading(true);
      try {
        const response = await listSavedSegments();
        if (
          !mountedRef.current ||
          generation !== loadGenerationRef.current ||
          ownerIdentity !== identityRef.current
        ) {
          return;
        }
        if (response.error) {
          setError(remoteFailureFromError(response.error).message);
          return;
        }
        if (!Array.isArray(response.data.items)) {
          setError(
            "Saved segments returned an invalid response. No empty state was assumed.",
          );
          return;
        }
        const serverMaximum =
          Number.isSafeInteger(response.data.max_items) &&
          Number(response.data.max_items) > 0
            ? Number(response.data.max_items)
            : SAVED_SEGMENT_MAX_ITEMS;
        const serverTotal =
          Number.isSafeInteger(response.data.total_items) &&
          Number(response.data.total_items) >= response.data.items.length
            ? Number(response.data.total_items)
            : response.data.items.length;
        setSegments(response.data.items);
        setTotal(serverTotal);
        setMaximum(serverMaximum);
        setError(null);
      } catch {
        if (
          mountedRef.current &&
          generation === loadGenerationRef.current &&
          ownerIdentity === identityRef.current
        ) {
          setError("Saved segments are unavailable.");
        }
      } finally {
        if (
          loadOwnerRef.current?.identity === ownerIdentity &&
          loadOwnerRef.current.generation === generation
        ) {
          loadOwnerRef.current = null;
        }
        if (
          mountedRef.current &&
          generation === loadGenerationRef.current &&
          ownerIdentity === identityRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    loadGenerationRef.current += 1;
    setMenuOpen(false);
    setSegments([]);
    setTotal(0);
    setMaximum(SAVED_SEGMENT_MAX_ITEMS);
    setError(null);
    void load({ supersede: true });
  }, [identityScope, load]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      loadOwnerRef.current = null;
    };
  }, []);

  return {
    segments,
    setSegments,
    total,
    setTotal,
    maximum,
    loading,
    error,
    menuOpen,
    setMenuOpen,
    previews: previews.previews,
    requestPreview: previews.requestPreview,
    invalidatePreviewCounts,
    load,
  };
}

export type SavedSegmentsLibrary = ReturnType<typeof useSavedSegmentsLibrary>;
