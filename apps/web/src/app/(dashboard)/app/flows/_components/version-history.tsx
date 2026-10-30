// SPDX-License-Identifier: AGPL-3.0-only
//
// Version-history rail for the flow editor. Lists the flow's published version
// snapshots and lets the operator snapshot the current graph as a new version
// (with an optional label — FLOW-025). Each row shows a diff against the
// current draft (FLOW-024) and the version matching it is marked "Current"
// (FLOW-045). Restoring a version back into the draft is release-held; the
// path stays wired but no enabled control reaches it — see
// RESTORE_RELEASE_HOLD_MESSAGE.
"use client";

import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { type Flow, type FlowGraph, flowsApi } from "@/lib/flows-api";
import {
  FLOW_READ_ONLY_MESSAGE,
  verifyFreshFlowWriteAuthority,
} from "@/lib/flow-write-authority";
import { diffGraphs, summarizeDiff } from "@/lib/flow-diff";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

// Restore POSTs the version-promote endpoint, and the server answers EVERY
// promote — `activate: false` included — with the flow-runtime-unavailable
// descriptor while the runtime is release-held (Deps.PromoteVersion returns it
// on every path, after decoding the body and without consulting the flag). A
// confirmable, destructive-styled "Restore into draft" therefore promises a
// draft replacement that never lands and then reports it as an execution
// failure ("the flow was not activated, published, or dispatched") for an
// action that never touched execution. State the hold instead of attempting
// the write, the way FlowActivationStatus does for activation.
const RESTORE_RELEASE_HOLD_MESSAGE =
  "Restoring a version into the draft is unavailable while the flow runtime is release-held. Snapshots still save, and every version stays readable and comparable here.";

export function VersionHistory({
  flowId,
  currentGraph,
  hasUnsavedEdits,
  identity,
  canWrite,
  onClose,
  onFlowReplaced,
}: {
  flowId: string;
  currentGraph: FlowGraph;
  hasUnsavedEdits: boolean;
  identity: MeResponse | null | undefined;
  canWrite: boolean;
  onClose: () => void;
  onFlowReplaced: (flow: Flow) => void;
}) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const versionsQuery = useQuery({
    queryKey: ["flow-versions", flowId],
    queryFn: () => flowsApi.listVersions(flowId),
  });

  const snapshot = useMutation({
    mutationFn: async () => {
      await verifyFreshFlowWriteAuthority(identity);
      return flowsApi.createVersion(flowId, {
        generated_by: "human",
        graph: currentGraph,
        ...(label.trim() ? { source_ref: label.trim() } : {}),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["flow-versions", flowId],
      });
      setLabel("");
      toast.success("Snapshot saved as a new version");
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Could not snapshot")),
  });

  // Retained write path, held rather than deleted: it stays wired behind fresh
  // authority so restore works the day the runtime hold lifts. Nothing enabled
  // reaches it — the trigger below is disabled and states the hold.
  const restore = useMutation({
    mutationFn: async (versionId: string) => {
      await verifyFreshFlowWriteAuthority(identity);
      return flowsApi.promoteVersion(flowId, versionId, false);
    },
    onSuccess: (flow: Flow) => {
      queryClient.setQueryData(["flow", flowId], flow);
      void queryClient.invalidateQueries({
        queryKey: ["flow-versions", flowId],
      });
      onFlowReplaced(flow);
      toast.success("Version restored into the draft");
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err, "Could not restore version")),
  });

  const versions = Array.isArray(versionsQuery.data?.items)
    ? versionsQuery.data.items
    : [];

  return (
    <aside className="flex min-h-0 w-full flex-col border-t border-border md:w-80 md:shrink-0 md:border-l md:border-t-0">
      <div className="flex items-center justify-between border-b border-border p-3">
        <p className="text-sm font-semibold">Version history</p>
        <IconButton
          size="sm"
          aria-label="Close version history"
          className="text-muted-foreground"
          onClick={onClose}
        >
          <span aria-hidden className="text-sm">
            ✕
          </span>
        </IconButton>
      </div>
      {!canWrite ? (
        <p
          role="note"
          className="border-b border-warning/40 bg-warning-subtle p-3 text-xs text-warning-emphasis"
        >
          Version history remains available to inspect. Creating snapshots and
          restoring drafts are unavailable. {FLOW_READ_ONLY_MESSAGE}
        </p>
      ) : null}
      <p
        role="note"
        className="border-b border-border p-3 text-xs text-muted-foreground"
      >
        {RESTORE_RELEASE_HOLD_MESSAGE}
      </p>
      <div className="space-y-2 border-b border-border p-3">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label this snapshot (optional)"
          className="h-8 text-xs"
          aria-label="Snapshot label"
          disabled={!canWrite}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => snapshot.mutate()}
          loading={snapshot.isPending}
          disabled={!canWrite}
          title={!canWrite ? FLOW_READ_ONLY_MESSAGE : undefined}
        >
          Snapshot current as version
        </Button>
      </div>
      <div
        role="region"
        aria-label="Saved flow versions"
        tabIndex={0}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {versionsQuery.isLoading ? (
          <div
            role="status"
            aria-label="Loading flow versions"
            className="space-y-2"
          >
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : versionsQuery.isError ? (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs"
          >
            <p>Could not load version history.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void versionsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : versions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No versions yet. Snapshot the current graph to start a history.
          </p>
        ) : (
          versions.map((v) => {
            const diff = diffGraphs(currentGraph, v.graph);
            const isCurrent = diff.identical;
            return (
              <div
                key={v.id}
                className="space-y-1 rounded-md border border-border bg-card p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    v{v.version}
                    {isCurrent ? (
                      <Badge variant="info" className="px-1.5 py-0 text-[10px]">
                        Current
                      </Badge>
                    ) : null}
                  </span>
                  {/* FLOW-008: version rows are draft/published/archived (never
                      "active" — that's the journey status). Published denotes
                      stored configuration, not runtime execution. */}
                  <Badge
                    variant={v.status === "published" ? "success" : "secondary"}
                  >
                    {v.status}
                  </Badge>
                </div>
                {v.source_ref ? (
                  <p className="break-words text-[11px] font-medium text-foreground">
                    {v.source_ref}
                  </p>
                ) : null}
                <p className="text-[11px] text-muted-foreground">
                  {v.generated_by} · {v.graph.nodes?.length ?? 0} steps ·{" "}
                  {formatDate(v.created_at)}
                </p>
                {/* Compare vs the current draft (FLOW-045). */}
                <p className="text-[11px] text-muted-foreground">
                  vs current draft: {summarizeDiff(diff)}
                </p>
                {isCurrent ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full"
                    disabled
                  >
                    Matches current draft
                  </Button>
                ) : (
                  // The trigger is held disabled, so this dialog cannot be
                  // opened until the runtime hold lifts. Re-enabling it before
                  // then re-creates the dead control it replaced.
                  <ConfirmDialog
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-full"
                        disabled
                        title={RESTORE_RELEASE_HOLD_MESSAGE}
                      >
                        Restore unavailable
                      </Button>
                    }
                    title={`Restore v${v.version}?`}
                    description={restoreDescription(diff, hasUnsavedEdits)}
                    confirmLabel="Restore"
                    confirmVariant="destructive"
                    onConfirm={() => restore.mutate(v.id)}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

function restoreDescription(
  diff: ReturnType<typeof diffGraphs>,
  hasUnsavedEdits: boolean,
): string {
  const changes = summarizeDiff(diff);
  const base = `This replaces your current draft with this version (${changes}).`;
  return hasUnsavedEdits
    ? `${base} You have unsaved edits that will be discarded.`
    : base;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
