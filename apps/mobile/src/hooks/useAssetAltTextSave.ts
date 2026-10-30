/**
 * hooks/useAssetAltTextSave.ts — the alt-text save, with its version gate and
 * its two failure sentences, lifted out of the assets screen.
 *
 * WHY IT IS ITS OWN HOOK. The screen body was already the densest function in
 * this surface, and threading the optimistic-concurrency version through it
 * pushed it past its budget. The save is a self-contained responsibility —
 * "turn a typed sentence into a version-gated PATCH and say what happened" —
 * so it moves whole rather than being trimmed at the edges.
 *
 * THE VERSION IS THE POINT. `Deps.Patch` demands a positive `expected_version`
 * (428 `expected_version_required`, handlers.go:487) and `Repo.UpdateAltText`
 * answers 412 `stale_version` when it no longer matches. The only honest source
 * of that number is the asset row itself, so when the row carries none this
 * hook returns `save: undefined` — the sheet then OMITS the affordance rather
 * than offering a button that could only ever fail.
 *
 * The 412 gets its own sentence because it is a different fact from a network
 * failure: nothing was overwritten, someone else got there first, and the
 * operator's wording is still on screen.
 */
import { useCallback } from "react";

import { useToast } from "@/components/Toast";
import { useUpdateAssetAltText } from "@/hooks/useAssets";
import type { MobileAsset } from "@/lib/assetLibrary";

export interface AssetAltTextSave {
  /** undefined when there is no honest way to send the write. */
  save: ((next: string) => Promise<boolean>) | undefined;
  saving: boolean;
}

/**
 * `asset` is the row the sheet is showing — the detail read's copy when it has
 * landed, otherwise the grid row. It is taken whole rather than as a version
 * number so the "which number, and is there one" question stays here, next to
 * the rule that needs it.
 */
export function useAssetAltTextSave(
  assetId: string | null,
  asset: MobileAsset | null,
): AssetAltTextSave {
  const { toast } = useToast();
  const mutation = useUpdateAssetAltText();
  const expectedVersion = asset === null ? null : asset.version;

  const save = useCallback(
    async (next: string): Promise<boolean> => {
      if (!assetId || expectedVersion === null) return false;
      try {
        await mutation.mutateAsync({
          id: assetId,
          altText: next,
          expectedVersion,
        });
        toast({ kind: "success", message: "Alt text saved." });
        return true;
      } catch (err) {
        const stale =
          (err as { code?: string } | null)?.code === "stale_version";
        toast({
          kind: "error",
          message: stale
            ? "This image changed while you were typing, so the description wasn't saved over it. Pull to refresh — your wording is kept."
            : "Couldn't save the alt text. Your wording is kept — try again.",
        });
        return false;
      }
    },
    [assetId, expectedVersion, mutation, toast],
  );

  return {
    save: assetId && expectedVersion !== null ? save : undefined,
    saving: mutation.isPending,
  };
}
