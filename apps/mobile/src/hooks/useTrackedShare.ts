/**
 * useTrackedShare — a share-sheet hand-off the transfer center can see.
 *
 * Desktop's file operations all report into lib/file-transfer-history so the
 * TransferCenter can list, retry and clear them. A phone's equivalent of
 * "save to a file" is the share sheet, and until now every `Share.share`
 * call was a fire-and-forget: nothing recorded that it happened, whether it
 * was dismissed, or offered to run it again. This wraps one share so it is a
 * row in lib/transferCenter for the rest of the session, with a retry when
 * the sheet failed to open.
 *
 * Scoped to the signed-in identity; the registry is purged on sign-out by the
 * same rule every other per-identity store follows.
 */
import { useCallback, useRef } from "react";
import { Share } from "react-native";

import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  finishLocalTransfer,
  registerLocalTransferRetry,
  startLocalTransfer,
} from "@/lib/transferCenter";
import { useAuthStore } from "@/store/auth";

export interface TrackedShareInput {
  /** What the row is called: "Diagnostics report", "Subscribers CSV". */
  label: string;
  message: string;
  title?: string;
}

export type TrackedShareOutcome = "shared" | "dismissed" | "failed";

/** The identity key transfer rows are filed under. */
export function useTransferScope(): string {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  return `${gate.baseUrl ?? ""}|${gate.tenantId ?? ""}|${gate.userId ?? mode ?? ""}`;
}

export function useTrackedShare(): (
  input: TrackedShareInput,
) => Promise<TrackedShareOutcome> {
  const scope = useTransferScope();
  const self = useRef<(input: TrackedShareInput) => Promise<TrackedShareOutcome>>(
    async () => "failed",
  );
  const share = useCallback(
    async (input: TrackedShareInput): Promise<TrackedShareOutcome> => {
      const id = startLocalTransfer({
        scope,
        direction: "share",
        label: input.label,
      });
      try {
        const result = await Share.share({
          message: input.message,
          ...(input.title ? { title: input.title } : {}),
        });
        if (result.action === Share.dismissedAction) {
          finishLocalTransfer(id, "cancelled", "Share sheet dismissed");
          registerLocalTransferRetry(id, () => void self.current(input));
          return "dismissed";
        }
        finishLocalTransfer(id, "done", "Handed to the share sheet");
        return "shared";
      } catch {
        finishLocalTransfer(id, "failed", "The share sheet could not open");
        registerLocalTransferRetry(id, () => void self.current(input));
        return "failed";
      }
    },
    [scope],
  );
  self.current = share;
  return share;
}
