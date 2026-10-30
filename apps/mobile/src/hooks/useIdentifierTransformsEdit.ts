/**
 * hooks/useIdentifierTransformsEdit.ts — the save mutation and the debounced
 * preview query behind the identifier-transforms editor sheet.
 *
 * The preview is a QUERY keyed on the draft + samples, not a hand-rolled
 * effect: a stale response from an earlier keystroke can then never overwrite
 * a newer one (TanStack discards it by key), and the 250ms debounce below is
 * the only thing standing between a typed character and a POST.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  previewIdentifierTransforms,
  updateIdentifierTransforms,
} from "@/api/identifierTransformsEdit";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  IdentifierTransformsPatch,
  TransformPreviewRequest,
} from "@/lib/identifierTransformsEdit";
import type { IdentifierTransformsView } from "@/lib/platformConfig";

/** Mirrors the read key in hooks/usePlatformConfig.ts, which is not exported. */
const TRANSFORMS_KEY = "mobile-identifier-transforms";
const PREVIEW_KEY = "mobile-identifier-transform-preview";
const PREVIEW_DEBOUNCE_MS = 250;

export function useUpdateIdentifierTransforms() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<IdentifierTransformsView, Error, IdentifierTransformsPatch>({
    mutationFn: updateIdentifierTransforms,
    onSuccess: (next) => {
      // The response IS the new truth; write it straight into the card's
      // query so the summary under the row changes with the sheet's close,
      // then invalidate so a refetch confirms it.
      qc.setQueryData([TRANSFORMS_KEY, gate.tenantId], next);
      void qc.invalidateQueries({ queryKey: [TRANSFORMS_KEY, gate.tenantId] });
    },
  });
}

/**
 * Dry-run `body` after it has been stable for a quarter second. Pass null
 * while the sheet is closed so no preview is fetched for nobody.
 */
export function useIdentifierTransformPreview(
  body: TransformPreviewRequest | null,
) {
  const gate = useOnlineQueryGate();
  const [settled, setSettled] = useState(body);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(body), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [body]);
  return useQuery({
    queryKey: [PREVIEW_KEY, gate.tenantId, settled],
    enabled: gate.enabled && Boolean(gate.tenantId) && settled !== null,
    staleTime: 60_000,
    // A 403 on preview is a final answer about this account's scopes; a
    // retry only delays saying so.
    retry: false,
    queryFn: () => {
      if (!settled) throw new Error("No preview requested.");
      return previewIdentifierTransforms(settled);
    },
  });
}
