// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { getRollbackStatus, rollback } from "@/lib/migration-api";
import type {
  MigrationJob,
  RollbackStatus,
  SourcePlatform,
  VerificationReport,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Progress } from "@/components/ui/progress";

export function RollbackSection({
  job,
  report,
  source,
  onRolledBack,
  beforeWrite,
}: {
  job: MigrationJob;
  report: VerificationReport | null;
  source: SourcePlatform;
  onRolledBack: (job: MigrationJob) => void;
  beforeWrite?: () => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [status, setStatus] = useState<RollbackStatus | null>(null);
  const rollingRef = useRef(false);

  // Poll while a rollback is running. We start polling the moment `rolling`
  // becomes true; the engine on the backend is async so we re-fetch every
  // second until state ∈ {completed, failed}.
  useEffect(() => {
    if (!rolling) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const nextStatus = await getRollbackStatus(job.id);
        if (cancelled) return;
        setStatus(nextStatus);
        if (nextStatus.state === "completed") {
          setRolling(false);
          toast.success("Rolled back");
          onRolledBack({ ...job, status: "rolled_back", rollback_until: null });
          return;
        }
        if (nextStatus.state === "failed") {
          setRolling(false);
          toast.error("Rollback failed", { description: nextStatus.error });
          return;
        }
        setTimeout(tick, 1000);
      } catch (err) {
        if (cancelled) return;
        setRolling(false);
        toast.error("Could not get rollback status", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [rolling, job, onRolledBack]);

  const handleConfirm = async () => {
    if (rollingRef.current) return;
    const jobId = job.id;
    rollingRef.current = true;
    try {
      await beforeWrite?.();
      await rollback(jobId);
      // Do not mount the status poller until the server has accepted the
      // rollback. Authority failures and rejected starts are not in-flight
      // rollbacks and must not issue misleading status reads.
      setRolling(true);
    } catch (err) {
      setRolling(false);
      toast.error("Could not start rollback", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      throw err;
    } finally {
      rollingRef.current = false;
    }
  };

  const subs = report?.subscribers_imported ?? job.progress.subscribers_done;
  const segs = report?.segments_translated ?? job.progress.segments_done;
  const autos = report?.automations_translated ?? job.progress.automations_done;
  const arch = report?.archive_imported ?? job.progress.archive_done;
  const templates =
    report?.templates_imported ?? job.progress.templates_done ?? 0;
  const paidSubs = report?.paid_subs_imported ?? job.progress.paid_subs_done;
  const sourceArchive =
    report?.source_archive_imported ?? job.progress.source_archive_done ?? 0;
  const hasRebuildOnlyAutomations =
    source === "activecampaign" ||
    source === "beehiiv" ||
    source === "klaviyo" ||
    source === "customerio";
  const automationRollbackLabel = hasRebuildOnlyAutomations
    ? "runtime automations"
    : "automations";
  const automationProgressLabel = hasRebuildOnlyAutomations
    ? "Runtime automations"
    : "Automations";

  if (status?.state === "completed") return null;

  return (
    <Card id="rollback-section">
      <CardHeader>
        <CardTitle className="text-base">Rollback this migration</CardTitle>
        <CardDescription>
          Reverses every write we made for this run. Available for 7 days from
          completion.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rolling && status ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Rolling back…</span>
              <span className="text-muted-foreground">
                {rollbackPct(status)}%
              </span>
            </div>
            <Progress
              value={rollbackPct(status)}
              aria-label="Migration rollback progress"
            />
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              <li>
                Archive {status.archive_deleted}/{status.archive_total}
              </li>
              <li>
                Templates {status.templates_deleted ?? 0}/
                {status.templates_total ?? 0}
              </li>
              <li>
                {automationProgressLabel} {status.automations_deleted}/
                {status.automations_total}
              </li>
              <li>
                Segments {status.segments_deleted}/{status.segments_total}
              </li>
              <li>
                Subscribers {status.subscribers_deleted.toLocaleString()}/
                {status.subscribers_total.toLocaleString()}
              </li>
              {(status.paid_subs_total ?? 0) > 0 ? (
                <li>
                  Paid subs {status.paid_subs_deleted ?? 0}/
                  {status.paid_subs_total ?? 0}
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </CardContent>
      {!rolling ? (
        <CardFooter>
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            <RotateCcw className="h-4 w-4" /> Rollback this migration
          </Button>
        </CardFooter>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!rollingRef.current) setConfirmOpen(next);
        }}
        title="Roll back this migration?"
        confirmLabel="Yes, roll back everything"
        confirmVariant="destructive"
        confirmationToken="DELETE"
        onConfirm={handleConfirm}
        description={
          <>
            This will delete all{" "}
            <strong>{subs.toLocaleString()} imported subscribers</strong>,{" "}
            <strong>{segs} segments</strong>,{" "}
            <strong>
              {autos} {automationRollbackLabel}
            </strong>
            , and <strong>{arch} archive entries</strong>
            {templates > 0 ? (
              <>
                , <strong>{templates} templates</strong>
              </>
            ) : null}
            {sourceArchive > 0 ? (
              <>
                , <strong>{sourceArchive} preserved source records</strong>
              </>
            ) : null}
            {paidSubs > 0 ? (
              <>
                , <strong>{paidSubs} paid subscription records</strong>
              </>
            ) : null}
            . This cannot be undone.
          </>
        }
      />
    </Card>
  );
}

function rollbackPct(status: RollbackStatus): number {
  const total =
    status.archive_total +
    (status.templates_total ?? 0) +
    status.automations_total +
    status.segments_total +
    status.subscribers_total +
    (status.paid_subs_total ?? 0);
  if (total === 0) return 0;
  const done =
    status.archive_deleted +
    (status.templates_deleted ?? 0) +
    status.automations_deleted +
    status.segments_deleted +
    status.subscribers_deleted +
    (status.paid_subs_deleted ?? 0);
  return Math.min(100, Math.round((done / total) * 100));
}
