/**
 * useMigrationJobActions — the confirm → mutate → toast chain for the two
 * job-level actions the screen offers.
 *
 * Lifted out of the screen component so Migrations stays readable (and
 * inside the app's function-length budget), and so the confirm copy for a
 * destructive, unresumable action lives in exactly one place rather than
 * being retyped next to the button.
 */
import { useCallback, useState } from "react";
import { Share } from "react-native";

import type { MobileMigrationJob } from "@/api/ops";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useCancelMigration } from "@/hooks/useGovernanceOps";
import { governanceActionErrorMessage } from "@/lib/governanceActionPolicy";
import { haptics } from "@/lib/haptics";

export interface MigrationJobActions {
  /** Job id currently being cancelled, or null. */
  cancellingId: string | null;
  cancel: (job: MobileMigrationJob) => void;
  shareId: (job: MobileMigrationJob) => void;
}

export function useMigrationJobActions(): MigrationJobActions {
  const { toast } = useToast();
  const confirm = useConfirm();
  const cancelJob = useCancelMigration();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const shareId = useCallback((job: MobileMigrationJob) => {
    void Share.share({ message: job.id }).catch(() => {
      /* the sheet was dismissed — not a failure worth interrupting for */
    });
  }, []);

  const run = useCallback(
    async (job: MobileMigrationJob) => {
      const source = String(job.source ?? "migration");
      const ok = await confirm({
        title: `Cancel the ${source} import?`,
        message:
          "The import stops where it is. Records already written stay written — undoing them is a rollback, which has to be run from the web admin.",
        confirmLabel: "Cancel import",
        destructive: true,
        confirmPhrase: source,
        consequence:
          "This cannot be resumed; the import would have to be started again.",
      });
      if (!ok) return;
      setCancellingId(job.id);
      try {
        await cancelJob.mutateAsync(job.id);
        // Cancelling a live import is unresumable: confirm the outcome in the
        // hand as well as on screen, so the answer does not depend on the
        // toast still being visible.
        haptics.success();
        toast({ kind: "success", message: `${source} import cancelled.` });
      } catch (err) {
        haptics.error();
        toast({
          kind: "error",
          message: governanceActionErrorMessage("cancel_migration", err),
        });
      } finally {
        setCancellingId(null);
      }
    },
    [cancelJob, confirm, toast],
  );

  const cancel = useCallback(
    (job: MobileMigrationJob) => {
      void run(job);
    },
    [run],
  );

  return { cancellingId, cancel, shareId };
}
