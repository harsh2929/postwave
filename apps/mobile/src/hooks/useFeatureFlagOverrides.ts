/**
 * hooks/useFeatureFlagOverrides.ts — the two writes behind the feature-flag
 * sheet. Both invalidate the card's list: the server answers `{id, key,
 * value}` (not a row) on upsert and nothing on delete, so there is no
 * response to write into the cache directly — a refetch is the only honest
 * way to show the new state.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  deleteFeatureFlagOverride,
  upsertFeatureFlag,
  type FlagUpsertResult,
} from "@/api/featureFlagOverrides";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { FlagUpsertBody } from "@/lib/featureFlagOverrides";

/** Mirrors the read key in hooks/usePlatformConfig.ts, which is not exported. */
const FLAGS_KEY = "mobile-feature-flags";

function useInvalidateFlags() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [FLAGS_KEY, gate.tenantId] });
  };
}

export function useUpsertFeatureFlag() {
  const invalidate = useInvalidateFlags();
  return useMutation<FlagUpsertResult, Error, FlagUpsertBody>({
    mutationFn: upsertFeatureFlag,
    onSuccess: invalidate,
  });
}

export function useDeleteFeatureFlagOverride() {
  const invalidate = useInvalidateFlags();
  return useMutation<void, Error, string>({
    mutationFn: deleteFeatureFlagOverride,
    // A 404 means the override was already gone: the list is stale either
    // way, so refetch on failure too rather than leaving a phantom row.
    onSettled: invalidate,
  });
}
