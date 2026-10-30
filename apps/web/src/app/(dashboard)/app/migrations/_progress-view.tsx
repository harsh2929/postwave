// SPDX-License-Identifier: AGPL-3.0-only
//
// Live progress view for an in-flight migration. Mirrors the desktop
// ProgressView shape but uses Tailwind + shadcn primitives to fit the
// existing web UI.
//
// Wires the SSE subscription via subscribeMigrationEvents() — falls
// back to polling automatically when SSE is blocked. Mounts its own
// cancel button that calls DELETE /api/v1/migrations/{id}.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellRing, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import {
  cancelMigrationJob,
  subscribeMigrationEvents,
  type MigrationStreamDone,
  type MigrationStreamProgress,
} from "@/lib/migration-progress-api";
import { migrationProgressPercent } from "@/lib/migration-progress-percent";
import type { SourcePlatform } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";

interface ActivityEntry {
  id: number;
  at: string;
  message: string;
}

interface Props {
  jobId: string;
  sourceLabel: string;
  source?: SourcePlatform;
  onComplete: (done: MigrationStreamDone) => void;
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
  authorityKey: string;
}

export function MigrationProgressView({
  jobId,
  sourceLabel,
  source,
  onComplete,
  beforeWrite,
  authorityKey,
}: Props) {
  const [snapshot, setSnapshot] = useState<
    MigrationStreamProgress["snapshot"] | null
  >(null);
  const [step, setStep] = useState("Starting…");
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [streamStatus, setStreamStatus] = useState<
    "connecting" | "open" | "reconnecting" | "closed" | "polling"
  >("connecting");
  const [cancelling, setCancelling] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  // Opt-in completion notification (MIGR-027). Fires a browser notification when
  // the import finishes so the user can switch tabs and be pinged, instead of
  // watching a long import. Requires the tab to stay open (the stream is
  // tab-scoped); true email/push-on-completion would need a backend endpoint.
  const [notifyWhenDone, setNotifyWhenDone] = useState(false);
  const notifyRef = useRef(false);
  const seqRef = useRef(0);
  const completedRef = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelBusyRef = useRef(false);
  const cancelControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setCancelling(false);
    setCancelOpen(false);
    return () => {
      cancelControllerRef.current?.abort();
      cancelControllerRef.current = null;
      cancelBusyRef.current = false;
    };
  }, [authorityKey]);

  const canNotify = typeof window !== "undefined" && "Notification" in window;

  const toggleNotify = useCallback(async () => {
    if (!canNotify) return;
    if (notifyWhenDone) {
      setNotifyWhenDone(false);
      notifyRef.current = false;
      return;
    }
    let permission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = "denied";
      }
    }
    if (permission === "granted") {
      setNotifyWhenDone(true);
      notifyRef.current = true;
      toast.success("We'll notify you when this import finishes", {
        description: "Keep this tab open in the background.",
      });
    } else {
      toast.error("Notifications are blocked", {
        description: "Allow notifications for this site to be pinged.",
      });
    }
  }, [canNotify, notifyWhenDone]);

  const maybeNotifyDone = useCallback(
    (status: MigrationStreamDone["status"]) => {
      if (!notifyRef.current || !canNotify) return;
      if (Notification.permission !== "granted") return;
      try {
        new Notification(
          status === "completed"
            ? `${sourceLabel} import complete`
            : `${sourceLabel} import ${status}`,
          {
            body:
              status === "completed"
                ? "Your migration finished. Open Moosewave to review it."
                : "Your migration stopped. Open Moosewave to see what happened.",
            tag: `migration-${jobId}`,
          },
        );
      } catch {
        /* notification construction can throw on some platforms — ignore */
      }
    },
    [canNotify, jobId, sourceLabel],
  );

  const pushActivity = useCallback((message: string, at?: string) => {
    seqRef.current += 1;
    setActivity((prev) =>
      prev
        .concat({
          id: seqRef.current,
          at: at ?? new Date().toISOString(),
          message,
        })
        .slice(-200),
    );
  }, []);

  useEffect(() => {
    const disconnect = subscribeMigrationEvents(jobId, {
      onSnapshot: (job) => {
        const j = job as { progress?: MigrationStreamProgress["snapshot"] };
        if (j.progress) setSnapshot(j.progress);
      },
      onProgress: (evt) => {
        const nextStep = displayProgressStep(source, evt);
        setStep(nextStep);
        setSnapshot(evt.snapshot);
        pushActivity(
          `${nextStep} (${evt.completed.toLocaleString()}${
            evt.total > 0 ? ` of ${evt.total.toLocaleString()}` : ""
          })`,
          evt.at,
        );
      },
      onDone: (evt) => {
        if (completedRef.current) return;
        completedRef.current = true;
        pushActivity(
          evt.status === "completed"
            ? "Migration complete."
            : evt.status === "failed"
              ? `Migration failed: ${evt.error ?? "unknown error"}`
              : `Migration ended (${evt.status}).`,
        );
        maybeNotifyDone(evt.status);
        onComplete(evt);
      },
      onError: (err) => {
        pushActivity(`Stream notice: ${err.message}`);
      },
      onStatus: setStreamStatus,
    });
    return disconnect;
  }, [jobId, pushActivity, source, onComplete, maybeNotifyDone]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [activity.length]);

  const overallPct = useMemo(
    () => migrationProgressPercent(snapshot, source),
    [snapshot, source],
  );

  const handleCancel = async () => {
    if (cancelBusyRef.current || completedRef.current) return;
    cancelBusyRef.current = true;
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    setCancelling(true);
    pushActivity("Cancellation requested…");
    try {
      await beforeWrite(controller.signal);
      controller.signal.throwIfAborted();
      const res = await cancelMigrationJob(jobId, controller.signal);
      controller.signal.throwIfAborted();
      pushActivity(
        res.cancelled
          ? "Cancellation acknowledged. Waiting for the runner to stop; cleanup options will appear on the migration detail page."
          : `No active runner (status: ${res.status}).`,
      );
      if (res.progress) setSnapshot(res.progress);
    } catch (err) {
      if (controller.signal.aborted) return;
      toast.error("Cancel failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      if (cancelControllerRef.current === controller) {
        cancelControllerRef.current = null;
        cancelBusyRef.current = false;
        if (!controller.signal.aborted) setCancelling(false);
      }
    }
  };

  return (
    <Card data-testid="migration-progress">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Importing from {sourceLabel}</CardTitle>
            <CardDescription>
              {step}
              <span className="ml-2 text-xs text-muted-foreground">
                · stream {streamStatus}
              </span>
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {canNotify ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void toggleNotify()}
                aria-pressed={notifyWhenDone}
                title={
                  notifyWhenDone
                    ? "You'll get a browser notification when this finishes"
                    : "Get a browser notification when this finishes"
                }
              >
                {notifyWhenDone ? (
                  <BellRing className="h-3.5 w-3.5" />
                ) : (
                  <Bell className="h-3.5 w-3.5" />
                )}
                {notifyWhenDone ? "Notify: on" : "Notify me"}
              </Button>
            ) : null}
            <Button
              ref={cancelButtonRef}
              variant="destructive"
              size="sm"
              onClick={() => setCancelOpen(true)}
              disabled={cancelling}
            >
              {cancelling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
              Cancel
            </Button>
          </div>
        </div>
      </CardHeader>
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel this migration?"
        description="We'll stop at the next batch, keep a record of what already landed, and show resume or rollback cleanup when the runner stops."
        confirmLabel="Cancel import"
        cancelLabel="Keep importing"
        onConfirm={handleCancel}
        fallbackFocusRef={cancelButtonRef}
      />
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Overall</span>
            <span className="text-muted-foreground tabular-nums">
              {overallPct}%
            </span>
          </div>
          <Progress
            value={overallPct}
            aria-label="Overall migration progress"
          />
        </div>
        <Separator />
        {snapshot ? (
          <div className="space-y-3">
            {progressRowsForSource(snapshot, source).map((row) =>
              row.total > 0 ? (
                <div key={row.label} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{row.label}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {row.valueLabel ??
                        `${row.done.toLocaleString()} / ${row.total.toLocaleString()}`}
                    </span>
                  </div>
                  <Progress
                    aria-label={`${row.label} migration progress`}
                    value={
                      row.progressValue ??
                      Math.round((row.done / row.total) * 100)
                    }
                  />
                </div>
              ) : null,
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Starting…</p>
        )}
        <Separator />
        <div
          ref={logRef}
          role="log"
          aria-live="polite"
          className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed"
        >
          {activity.length === 0 ? (
            <span className="text-muted-foreground">
              Waiting for the first batch…
            </span>
          ) : (
            activity.map((e) => (
              <div key={e.id} className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground tabular-nums">
                  {fmtTime(e.at)}
                </span>
                <span>{e.message}</span>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export interface MigrationProgressRow {
  label: string;
  done: number;
  total: number;
  valueLabel?: string;
  progressValue?: number;
}

export function progressRowsForSource(
  snapshot: MigrationStreamProgress["snapshot"],
  source?: SourcePlatform,
): MigrationProgressRow[] {
  const rebuildAutomationTotal = snapshot.automations_total;
  const beehiivPremiumMetadataDone =
    snapshot.subscribers_total > 0 &&
    snapshot.subscribers_done >= snapshot.subscribers_total
      ? snapshot.paid_subs_total
      : 0;
  return [
    {
      label:
        source === "klaviyo"
          ? "Primary-email profiles"
          : source === "customerio"
            ? "Email-addressable cio_id profiles"
            : "Subscribers",
      done: snapshot.subscribers_done,
      total: snapshot.subscribers_total,
    },
    {
      label:
        source === "customerio"
          ? "Frozen segment/topic memberships"
          : source === "klaviyo"
            ? "Suppression-filtered audience snapshots"
            : source === "beehiiv"
              ? "Frozen segment/list snapshots"
              : "Segments",
      done: snapshot.segments_done,
      total: snapshot.segments_total,
    },
    source === "activecampaign" ||
    source === "beehiiv" ||
    source === "klaviyo" ||
    source === "customerio"
      ? {
          label:
            source === "beehiiv"
              ? "Automation rebuild inventory"
              : source === "klaviyo"
                ? "Flow rebuild inventory"
                : source === "customerio"
                  ? "Workflow rebuild inventory"
                  : "Automation rebuilds",
          done: rebuildAutomationTotal,
          total: rebuildAutomationTotal,
          valueLabel:
            source === "beehiiv"
              ? `${rebuildAutomationTotal.toLocaleString()} to rebuild or retire`
              : source === "klaviyo"
                ? `${rebuildAutomationTotal.toLocaleString()} flows to rebuild or waive`
                : source === "customerio"
                  ? `${rebuildAutomationTotal.toLocaleString()} workflows to rebuild or retire`
                  : `${rebuildAutomationTotal.toLocaleString()} to review`,
          progressValue: 100,
        }
      : {
          label: "Sequences",
          done: snapshot.automations_done,
          total: snapshot.automations_total,
        },
    {
      label:
        source === "klaviyo"
          ? "Sent email campaign archive"
          : source === "customerio"
            ? "Sent email newsletter archive"
            : "Archive",
      done: snapshot.archive_done,
      total: snapshot.archive_total,
    },
    source === "beehiiv"
      ? {
          label: "Premium memberships (metadata only)",
          done: beehiivPremiumMetadataDone,
          total: snapshot.paid_subs_total,
          valueLabel: `${snapshot.paid_subs_total.toLocaleString()} metadata records; no Stripe billing`,
          progressValue:
            snapshot.paid_subs_total === 0
              ? 100
              : Math.round(
                  (beehiivPremiumMetadataDone / snapshot.paid_subs_total) * 100,
                ),
        }
      : source === "customerio"
        ? {
            label: "Paid subscriptions (not imported)",
            done: 0,
            total: 0,
            valueLabel: "Out of scope",
            progressValue: 100,
          }
        : {
            label: "Paid subs",
            done: snapshot.paid_subs_done,
            total: snapshot.paid_subs_total,
          },
    {
      label: "Templates",
      done: snapshot.templates_done ?? 0,
      total: snapshot.templates_total ?? 0,
    },
    {
      label:
        source === "customerio"
          ? "Workflow/channel/ecosystem evidence"
          : source === "klaviyo"
            ? "SMS/push and rebuild source archive"
            : "Source archive",
      done: snapshot.source_archive_done ?? 0,
      total: snapshot.source_archive_total ?? 0,
    },
  ];
}

export function displayProgressStep(
  source: SourcePlatform | undefined,
  evt: Pick<
    MigrationStreamProgress,
    "resource" | "completed" | "total" | "current_step"
  >,
): string {
  if (
    (source === "activecampaign" ||
      source === "beehiiv" ||
      source === "klaviyo" ||
      source === "customerio") &&
    evt.resource === "automations"
  ) {
    if (evt.total > 0 && evt.completed < evt.total) {
      return source === "beehiiv"
        ? "Preserving Beehiiv automation rebuild evidence"
        : source === "klaviyo"
          ? "Preserving Klaviyo flow rebuild evidence"
          : source === "customerio"
            ? "Preserving Customer.io workflow rebuild evidence"
            : "Preserving automation rebuild evidence";
    }
    return source === "beehiiv"
      ? "Beehiiv automation rebuild inventory complete"
      : source === "klaviyo"
        ? "Klaviyo flow rebuild inventory complete"
        : source === "customerio"
          ? "Customer.io workflow rebuild inventory complete"
          : "Automation rebuild evidence complete";
  }
  return evt.current_step;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}
