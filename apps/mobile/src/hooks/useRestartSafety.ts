/**
 * useRestartSafety — desktop's pre-restart safety scan, on the phone.
 *
 * DesktopUpdateService asks every registered guard whether a relaunch is safe
 * and shows the concerns in the confirm; DesktopLifecycleService registers
 * them (active send, unsaved drafts). Mobile's confirm carried one number.
 * The scan itself is lib/restartSafetyScan (pure); this file binds the three
 * registries the phone already keeps — lib/dirtyGuard, the offline queue and
 * the transfer center — and turns the verdict into the ONE restart path both
 * the update toast and the diagnostics card go through, so they cannot make
 * different promises.
 *
 *   safe     → restart on the tap.
 *   warnings → confirm with the concerns; cancel = "Remind me in 4 hours".
 *   blocking → no restart; the reason, and where the update waits.
 */
import { useCallback, useEffect, useState } from "react";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { applyAppUpdate } from "@/hooks/useAppUpdate";
import { unsavedLabels } from "@/lib/dirtyGuard";
import { haptics } from "@/lib/haptics";
import { currentOfflineAuthScope } from "@/lib/offlineMutations";
import { listOfflineMutationQueue } from "@/lib/offlineMutationQueue";
import { queryClient } from "@/lib/queryClient";
import {
  blockedRestartMessage,
  deferRestartReminder,
  restartPromptCopy,
  scanRestartSafety,
  type RestartSafetyScan,
} from "@/lib/restartSafetyScan";
import {
  activeLocalTransferCount,
  subscribeTransferCenter,
} from "@/lib/transferCenter";

export const RESTART_DEFERRED_TOAST =
  "Restart reminder set for four hours from now.";

/** One scan over everything the phone tracks, right now. */
export function scanRestartSafetyNow(): RestartSafetyScan {
  let queue: { status: "queued" | "syncing" | "sent" | "failed" }[] = [];
  try {
    queue = listOfflineMutationQueue(queryClient, currentOfflineAuthScope());
  } catch {
    // No resolvable identity — nothing of ours is at risk.
    queue = [];
  }
  const rows = Array.isArray(queue) ? queue : [];
  return scanRestartSafety({
    unsavedLabels: unsavedLabels(),
    queue: rows,
    activeTransfers: activeLocalTransferCount(),
  });
}

/**
 * A live scan for the diagnostics card. Re-read on every queue or transfer
 * event; the dirty registry has no subscription, so it is re-read alongside
 * those and on mount — which is when the card is looked at.
 */
export function useRestartSafety(enabled: boolean): RestartSafetyScan {
  const [scan, setScan] = useState<RestartSafetyScan>(() =>
    scanRestartSafetyNow(),
  );
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const rescan = () => {
      queueMicrotask(() => {
        if (live) setScan(scanRestartSafetyNow());
      });
    };
    rescan();
    const stopQueue = queryClient.getMutationCache().subscribe(rescan);
    const stopTransfers = subscribeTransferCenter(rescan);
    return () => {
      live = false;
      stopQueue();
      stopTransfers();
    };
  }, [enabled]);
  return scan;
}

export type GuardedRestartOutcome =
  | "restarted"
  | "blocked"
  | "deferred"
  | "failed";

/**
 * The restart every surface calls. Returns what happened so a caller can
 * schedule the reminder or stay quiet.
 */
export function useGuardedRestart(): () => Promise<GuardedRestartOutcome> {
  const confirm = useConfirm();
  const { toast } = useToast();
  return useCallback(async () => {
    const scan = scanRestartSafetyNow();
    if (scan.blocking.length > 0) {
      haptics.warning();
      toast({ kind: "warning", message: blockedRestartMessage(scan) });
      return "blocked";
    }
    const copy = restartPromptCopy(scan);
    if (copy) {
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        consequence: copy.consequence,
        confirmLabel: copy.confirmLabel,
        cancelLabel: copy.cancelLabel,
        destructive: copy.destructive,
      });
      if (!ok) {
        deferRestartReminder();
        toast({ kind: "info", message: RESTART_DEFERRED_TOAST });
        return "deferred";
      }
    }
    try {
      await applyAppUpdate();
      return "restarted";
    } catch {
      haptics.error();
      toast({
        kind: "error",
        message: "Couldn't restart. Close and reopen Moosewave to update.",
      });
      return "failed";
    }
  }, [confirm, toast]);
}
