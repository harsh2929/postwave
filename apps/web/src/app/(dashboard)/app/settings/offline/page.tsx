// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Inbox, RefreshCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { flushQueuedMutations } from "@/lib/api";
import { getOnlineStatus } from "@/lib/online-manager";
import {
  OFFLINE_QUEUE_CHANGED_EVENT,
  readOfflineQueue,
  removeOfflineMutation,
  updateOfflineMutation,
  writeOfflineQueue,
  type OfflineMutation,
} from "@/lib/offline-store";
import { describeOfflineMutation } from "@/lib/offline-describe";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RelativeTime } from "@/components/relative-time";
import { ConflictModal } from "@/components/conflict-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export default function OfflineSettingsPage() {
  const [items, setItems] = useState<OfflineMutation[]>([]);
  const [flushing, setFlushing] = useState(false);
  const [conflictItem, setConflictItem] = useState<OfflineMutation | null>(
    null,
  );
  const flushingRef = useRef(false);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);

  const refresh = () => setItems(readOfflineQueue());

  useEffect(() => {
    refresh();
    window.addEventListener(OFFLINE_QUEUE_CHANGED_EVENT, refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.removeEventListener(OFFLINE_QUEUE_CHANGED_EVENT, refresh);
      window.removeEventListener("online", refresh);
    };
  }, []);

  const counts = useMemo(
    () => ({
      pending: items.filter((item) => item.status === "pending").length,
      replaying: items.filter((item) => item.status === "replaying").length,
      conflict: items.filter((item) => item.status === "conflict").length,
      failed: items.filter(
        (item) => item.status === "failed" || item.status === "dead-letter",
      ).length,
    }),
    [items],
  );

  const replayableCount = items.filter(
    (item) => item.status === "pending" || item.status === "failed",
  ).length;

  const retryOne = async (item: OfflineMutation) => {
    if (flushingRef.current) return;
    updateOfflineMutation(item.id, {
      status: "pending",
      attempts: 0,
      lastError: undefined,
    });
    await replayNow();
  };

  // Undo-able discard: capture the item, remove it, and offer to restore it so a
  // single mis-click can't permanently lose queued offline work (SETA-021).
  const discardOne = (item: OfflineMutation) => {
    const originalIndex = readOfflineQueue().findIndex(
      (candidate) => candidate.id === item.id,
    );
    removeOfflineMutation(item.id);
    refresh();
    toast.success("Queued change discarded.", {
      action: {
        label: "Undo",
        onClick: () => {
          const current = readOfflineQueue();
          if (current.some((candidate) => candidate.id === item.id)) return;
          const restored = [...current];
          restored.splice(
            Math.min(Math.max(originalIndex, 0), restored.length),
            0,
            item,
          );
          writeOfflineQueue(restored);
          refresh();
        },
      },
    });
  };

  const retryAllFailed = async () => {
    if (flushingRef.current) return;
    const failed = items.filter(
      (item) => item.status === "failed" || item.status === "dead-letter",
    );
    if (failed.length === 0) return;
    for (const item of failed) {
      updateOfflineMutation(item.id, {
        status: "pending",
        attempts: 0,
        lastError: undefined,
      });
    }
    await replayNow();
  };

  const discardAll = () => {
    const snapshot = readOfflineQueue();
    if (snapshot.length === 0) return;
    writeOfflineQueue([]);
    refresh();
    toast.success(
      `${snapshot.length} queued change${snapshot.length === 1 ? "" : "s"} discarded.`,
      {
        action: {
          label: "Undo",
          onClick: () => {
            const discardedIds = new Set(snapshot.map((item) => item.id));
            const queuedSinceDiscard = readOfflineQueue().filter(
              (item) => !discardedIds.has(item.id),
            );
            writeOfflineQueue([...snapshot, ...queuedSinceDiscard]);
            refresh();
          },
        },
      },
    );
  };

  const resolveKeepServer = (id: string) => {
    removeOfflineMutation(id);
    refresh();
    setConflictItem(null);
    toast.success("Kept the server version.");
  };

  const resolveKeepMine = (id: string) => {
    // Re-issue with If-Match:* so the server overwrites (valid for 412 version
    // conflicts; uniqueness 409s only offer keep-server).
    updateOfflineMutation(id, {
      headers: { "if-match": "*" },
      baseVersion: "*",
      status: "pending",
      attempts: 0,
      lastError: undefined,
    });
    setConflictItem(null);
    void replayNow();
  };

  const replayNow = async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    setFlushing(true);
    try {
      const queuedBefore = readOfflineQueue();
      if (navigator.onLine === false || getOnlineStatus() === "offline") {
        const reconnectable = queuedBefore.filter(
          (item) => item.status === "pending" || item.status === "failed",
        ).length;
        toast.message(
          reconnectable > 0
            ? `${reconnectable} queued change${reconnectable === 1 ? "" : "s"} will sync after reconnecting.`
            : "Queued conflicts or stopped changes still need attention after reconnecting.",
        );
        return;
      }
      const result = await flushQueuedMutations();
      refresh();
      const needsAttention = result.conflicts + result.failed;
      if (needsAttention > 0) {
        toast.warning(
          result.replayed > 0
            ? `${result.replayed} queued change${result.replayed === 1 ? "" : "s"} synced; ${needsAttention} queued change${needsAttention === 1 ? " needs" : "s need"} attention.`
            : `${needsAttention} queued change${needsAttention === 1 ? " needs" : "s need"} attention.`,
        );
      } else if (result.replayed > 0) {
        toast.success(
          `${result.replayed} queued change${result.replayed === 1 ? "" : "s"} synced.`,
        );
      } else if (
        readOfflineQueue().some(
          (item) =>
            item.status === "pending" &&
            typeof item.retryableAt === "number" &&
            item.retryableAt > Date.now(),
        )
      ) {
        toast.message("Queued changes are waiting for their retry window.");
      } else {
        toast.message("No pending offline changes to sync.");
      }
    } catch {
      refresh();
      toast.error(
        "Offline sync could not finish. Queued changes remain available to retry.",
      );
    } finally {
      flushingRef.current = false;
      setFlushing(false);
    }
  };

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <h2
          ref={pageHeadingRef}
          tabIndex={-1}
          className="font-display text-xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Offline Sync
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review queued edits, replay pending work, and clear conflicts. For
          security, web queues stay only in this tab, expire after four hours,
          and are discarded by reload, sign-out, or workspace switch.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-4">
        <Summary label="Pending" value={counts.pending} />
        <Summary label="Replaying" value={counts.replaying} />
        <Summary label="Conflicts" value={counts.conflict} />
        <Summary label="Failed" value={counts.failed} />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={flushing || counts.failed === 0}
          onClick={() => void retryAllFailed()}
        >
          Retry all failed
        </Button>
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="ghost"
              disabled={flushing || items.length === 0}
            >
              Discard all
            </Button>
          }
          title="Discard every queued change?"
          description={`${items.length} queued change${items.length === 1 ? "" : "s"} will be removed from this tab. You can undo immediately from the confirmation toast.`}
          confirmLabel="Discard all"
          fallbackFocusRef={pageHeadingRef}
          onConfirm={discardAll}
        />
        <Button
          type="button"
          variant="outline"
          disabled={flushing || replayableCount === 0}
          onClick={() => void replayNow()}
          loading={flushing}
        >
          <RefreshCcw className="h-4 w-4" />
          Sync pending
        </Button>
      </div>

      <Card aria-busy={flushing}>
        <CardHeader>
          <CardTitle>Pending actions</CardTitle>
          <CardDescription>
            Failed, stopped, and conflicting rows wait here until you retry,
            resolve, discard, close, or reload this tab.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Nothing queued"
              description="Edits made while offline appear here until they sync. You're all caught up."
            />
          ) : (
            <TableContainer aria-label="Queued offline changes">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Action</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Queued</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead className="text-right">Controls</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id} className="align-top">
                      <TableCell>
                        <div className="font-medium">
                          {describeOfflineMutation(item)}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {item.method} {item.path}
                        </div>
                        {item.lastError ? (
                          <div className="mt-1 text-xs text-destructive">
                            {item.lastError}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={item.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <RelativeTime iso={item.queuedAt} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.attempts}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          {item.status === "conflict" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={flushing}
                              onClick={() => setConflictItem(item)}
                            >
                              Resolve
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={flushing || item.status === "replaying"}
                              onClick={() => void retryOne(item)}
                            >
                              Retry
                            </Button>
                          )}
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            disabled={flushing || item.status === "replaying"}
                            title="Discard"
                            aria-label={`Discard ${describeOfflineMutation(item)}`}
                            onClick={() => discardOne(item)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      <ConflictModal
        open={conflictItem !== null}
        item={conflictItem}
        onClose={() => setConflictItem(null)}
        onKeepMine={resolveKeepMine}
        onKeepServer={resolveKeepServer}
      />
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-card px-4 py-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: OfflineMutation["status"] }) {
  const variant =
    status === "conflict" || status === "failed" || status === "dead-letter"
      ? "destructive"
      : status === "replaying"
        ? "secondary"
        : "outline";
  return (
    <Badge
      variant={variant}
      title={status === "dead-letter" ? "Automatic retries stopped" : undefined}
    >
      {status === "dead-letter" ? "stopped" : status}
    </Badge>
  );
}
