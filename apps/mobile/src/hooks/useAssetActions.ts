/**
 * hooks/useAssetActions.ts — the three things this surface DOES, away from the
 * thing it shows.
 *
 * Split out of app/(tabs)/assets.tsx when that route crossed its source budget.
 * The seam is not merely mechanical: the screen is a grid with filters, while
 * this is the consequential half — picking bytes off the device, pushing them
 * over a metered link, and removing something a live campaign may still be
 * pointing at. Keeping them apart means the risky logic reads on one page.
 *
 * THE DELETE ESCALATION IS THE SERVER'S, NOT A UI FLOURISH. `DELETE /{id}` is
 * refused with 409 `has_references` for any asset a live campaign, template or
 * form still embeds, and `?force=true` is the documented override
 * (handlers.go:459-491). So:
 *
 *   1. The prompt is chosen from the reference count we believe (typed-phrase
 *      gate when it is non-zero OR unknown — see `assetDeletePrompt`).
 *   2. If the server disagrees and 409s anyway — a teammate dropped the image
 *      into a draft since the read — the operator is asked AGAIN, with the
 *      typed-phrase gate, rather than shown a bare failure. The server's answer
 *      is the authority; ours was a prediction.
 *
 * NOTHING HERE IS OPTIMISTIC OR QUEUED. See the header of hooks/useAssets.ts:
 * lib/offlineQueueSafety already makes both verbs online-only, and the
 * paused-mutation journal physically cannot hold megabytes of base64.
 */
import { useCallback } from "react";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useDeleteAsset, useUploadAsset } from "@/hooks/useAssets";
import {
  captureAssetWithCamera,
  copyToClipboard,
  pickAssetFromLibrary,
  type AssetPickOutcome,
} from "@/lib/assetCapture";
import type { MobileAsset } from "@/lib/assetLibrary";
import {
  assetDeleteErrorMessage,
  assetDeletePrompt,
  assetUploadErrorMessage,
  isAssetReferencedError,
} from "@/lib/assetErrors";
import {
  assetStoredFilename,
  evaluateAssetUpload,
} from "@/lib/assetUploadPolicy";
import {
  assetVersionErrorMessage,
  assetWriteBlockNote,
  isAssetRowVersion,
} from "@/lib/assetVersionGate";
import { haptics } from "@/lib/haptics";

export interface AssetActionsInput {
  /**
   * The reference count from the single read, which RECOMPUTES it. Null when
   * that read has not landed — deliberately distinct from zero, and treated as
   * "referenced" by the prompt.
   */
  recomputedCount: number | null;
  onUploaded: () => void;
  onDeleted: () => void;
}

export interface AssetActions {
  uploading: boolean;
  deleting: boolean;
  pickFromLibrary: () => void;
  pickFromCamera: () => void;
  copyUrl: (url: string) => void;
  removeAsset: (asset: MobileAsset) => void;
}

export function useAssetActions(input: AssetActionsInput): AssetActions {
  const { toast } = useToast();
  const confirm = useConfirm();
  const upload = useUploadAsset();
  const remove = useDeleteAsset();
  const { onDeleted, onUploaded, recomputedCount } = input;

  const send = useCallback(
    async (outcome: AssetPickOutcome) => {
      if (outcome.status === "cancelled") return;
      if (outcome.status !== "picked") {
        haptics.error();
        toast({ kind: "error", message: outcome.message });
        return;
      }
      // The server's own rules, applied before a byte leaves the phone: a 12 MB
      // photo would otherwise cost a full cellular upload to be refused.
      const decision = evaluateAssetUpload(outcome.candidate);
      if (!decision.ok || !decision.mime) {
        haptics.error();
        toast({ kind: "error", message: decision.message });
        return;
      }
      const filename = assetStoredFilename(
        outcome.candidate.fileName,
        decision.mime,
      );
      try {
        const saved = await upload.mutateAsync({
          filename,
          mime: decision.mime,
          contentBase64: outcome.candidate.base64 ?? "",
        });
        haptics.success();
        onUploaded();
        toast({
          kind: "success",
          message: `${saved?.filename ?? filename} added to the library.`,
        });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: assetUploadErrorMessage(error, "Couldn't upload that image."),
        });
      }
    },
    [onUploaded, toast, upload],
  );

  const pickFromLibrary = useCallback(() => {
    haptics.tap();
    void pickAssetFromLibrary().then(send);
  }, [send]);

  const pickFromCamera = useCallback(() => {
    haptics.tap();
    void captureAssetWithCamera().then(send);
  }, [send]);

  const copyUrl = useCallback(
    (url: string) => {
      haptics.tap();
      void copyToClipboard(url).then((copied) => {
        toast(
          copied
            ? { kind: "success", message: "Image address copied." }
            : {
                kind: "error",
                message: "Your phone wouldn't let the app use the clipboard.",
              },
        );
      });
    },
    [toast],
  );

  const commit = useCallback(
    async (asset: MobileAsset, expectedVersion: number, force: boolean) => {
      await remove.mutateAsync({ id: asset.id, expectedVersion, force });
      haptics.success();
      onDeleted();
      toast({
        kind: "success",
        message: `${asset.filename || "Image"} deleted.`,
      });
    },
    [onDeleted, remove, toast],
  );

  const reportDeleteFailure = useCallback(
    (error: unknown) => {
      haptics.error();
      toast({
        kind: "error",
        // A 412 is not a network failure and must not read like one: nothing
        // was deleted and someone else moved the row first.
        message:
          assetVersionErrorMessage(error, "image") ??
          assetDeleteErrorMessage(error, "Couldn't delete that image."),
      });
    },
    [toast],
  );

  const removeAsset = useCallback(
    (asset: MobileAsset) => {
      if (remove.isPending) return;
      // The delete is version-gated and the only honest source of the number is
      // this row. The sheet already WITHHOLDS the button when it is missing
      // (assets.tsx passes no `onDelete`), so this is the second line of the
      // same rule rather than the operator's first news of it.
      const expectedVersion = asset.version;
      if (!isAssetRowVersion(expectedVersion)) {
        haptics.error();
        toast({
          kind: "error",
          message: assetWriteBlockNote(true, true, false) ?? "",
        });
        return;
      }
      const count = recomputedCount ?? asset.referencesCount;
      const referenced = count === null || count > 0;
      void (async () => {
        if (!(await confirm({ ...assetDeletePrompt(asset.filename, count) }))) {
          return;
        }
        try {
          await commit(asset, expectedVersion, referenced);
        } catch (error) {
          if (!isAssetReferencedError(error)) {
            reportDeleteFailure(error);
            return;
          }
          // Our count was stale and the server says so. Ask again, with the
          // typed-phrase gate, rather than reporting a plain failure.
          if (!(await confirm({ ...assetDeletePrompt(asset.filename, null) }))) {
            toast({ kind: "info", message: "Left in place." });
            return;
          }
          try {
            // The SAME version: a 409 `has_references` wrote nothing, so the
            // row has not moved and re-reading it would only widen the window
            // in which a teammate could.
            await commit(asset, expectedVersion, true);
          } catch (retryError) {
            reportDeleteFailure(retryError);
          }
        }
      })();
    },
    [commit, confirm, recomputedCount, remove.isPending, reportDeleteFailure, toast],
  );

  return {
    uploading: upload.isPending,
    deleting: remove.isPending,
    pickFromLibrary,
    pickFromCamera,
    copyUrl,
    removeAsset,
  };
}
