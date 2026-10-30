// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { useQuery } from "@tanstack/react-query";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { listAuditLog, type AuditRow } from "@/lib/audit-api";
import {
  landingPagesApi,
  type LandingPage,
  type LandingPageVersion,
} from "@/lib/landing-pages-api";
import { statusLabel } from "@/lib/landing-list-helpers";
import { STALE } from "@/lib/query-keys";
import type { MeResponse } from "@/lib/auth-api";
import {
  confirmFreshLandingPageAdminAuthority,
  LANDING_PAGE_ADMIN_ONLY_MESSAGE,
} from "@/lib/landing-page-authority";

const AUDIT_ACTION_LABELS: Record<string, string> = {
  "landing_page.create": "Created",
  "landing_page.update": "Edited content",
  "landing_page.publish": "Published",
  "landing_page.unpublish": "Unpublished",
  "landing_page.archive": "Archived",
  "landing_page.restore": "Restored a version",
};

function auditActionLabel(row: AuditRow): string {
  const known = AUDIT_ACTION_LABELS[row.action];
  if (known) return known;
  const version = row.metadata?.["version_no"];
  if (row.action === "landing_page.restore" && typeof version === "number") {
    return `Restored version ${version}`;
  }
  return row.action;
}

// LAND-039: activity and reversible version history stay dormant until the
// operator opens the History tab. This avoids fetching sensitive audit data or
// shipping restore controls to every landing-page edit session.
export function HistoryTab({
  pageId,
  baseKey,
  identity,
  canAdmin,
  onRestored,
}: {
  pageId: string;
  baseKey: readonly unknown[];
  identity: MeResponse | null | undefined;
  canAdmin: boolean;
  onRestored: (updated: LandingPage) => void;
}) {
  const [confirm, setConfirm] = useState<LandingPageVersion | null>(null);
  const [restoring, setRestoring] = useState(false);
  const restoringRef = useRef(false);

  const activity = useQuery({
    queryKey: [...baseKey, "activity", pageId] as const,
    queryFn: ({ signal }) =>
      listAuditLog(
        { resourceType: "landing_page", resourceId: pageId, limit: 50 },
        { signal },
      ),
    enabled: canAdmin,
    staleTime: STALE.list,
  });
  const versions = useQuery({
    queryKey: [...baseKey, "versions", pageId] as const,
    queryFn: () => landingPagesApi.listVersions(pageId),
    staleTime: STALE.list,
  });

  useEffect(() => {
    if (canAdmin) return;
    setConfirm(null);
  }, [canAdmin]);

  async function restore(version: LandingPageVersion) {
    if (!canAdmin || !identity) {
      toast.error(LANDING_PAGE_ADMIN_ONLY_MESSAGE);
      return;
    }
    if (restoringRef.current) return;
    const intent = {
      versionNo: version.version_no,
    } as const;
    restoringRef.current = true;
    setRestoring(true);
    try {
      await confirmFreshLandingPageAdminAuthority(identity);
      const updated = await landingPagesApi.restoreVersion(
        pageId,
        intent.versionNo,
      );
      onRestored(updated);
      await Promise.all([activity.refetch(), versions.refetch()]);
      toast.success(`Restored version ${intent.versionNo}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Restore failed.");
    } finally {
      restoringRef.current = false;
      setRestoring(false);
      setConfirm(null);
    }
  }

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-md border bg-card p-4">
        <div>
          <h2 className="text-sm font-semibold">Version history</h2>
          <p className="text-xs text-muted-foreground">
            Every save snapshots the previous content. Restore rolls the page
            back — and is itself reversible because the last saved content is
            snapshotted first. Unsaved edits are not. The public URL is
            preserved.
          </p>
        </div>
        {versions.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading versions…
          </p>
        ) : versions.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            <p>Could not load version history.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void versions.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (versions.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No prior versions yet. The first snapshot is taken the next time you
            save an edit.
          </p>
        ) : (
          <ul className="divide-y">
            {(Array.isArray(versions.data) ? versions.data : []).map(
              (version) => (
                <li
                  key={version.version_no}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        Version {version.version_no}
                      </span>
                      <Badge variant="outline">
                        {statusLabel(version.status)}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {version.name || "Untitled"} · saved{" "}
                      <RelativeTime iso={version.created_at} />
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canAdmin || restoring}
                    title={
                      !canAdmin ? LANDING_PAGE_ADMIN_ONLY_MESSAGE : undefined
                    }
                    onClick={() => setConfirm(structuredClone(version))}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restore
                  </Button>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <section className="space-y-3 rounded-md border bg-card p-4">
        <div>
          <h2 className="text-sm font-semibold">Activity</h2>
          <p className="text-xs text-muted-foreground">
            Who changed this page and when.
          </p>
        </div>
        {!canAdmin ? (
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Activity includes raw audit evidence and is available only to owners
            and admins outside viewer mode.
          </p>
        ) : activity.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading activity…
          </p>
        ) : activity.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            <p>Could not load activity.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void activity.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (activity.data?.rows ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recorded activity yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {(Array.isArray(activity.data?.rows) ? activity.data.rows : []).map(
              (row) => (
                <li
                  key={row.id}
                  className="flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <span className="text-sm">{auditActionLabel(row)}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      by {row.actorLabel || row.actorType}
                    </span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <RelativeTime iso={row.at} />
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm ? `Restore version ${confirm.version_no}?` : "Restore"}
        // The server snapshots the STORED page, not what the editor is holding,
        // and onRestored replaces the whole model. Unsaved edits on the Content
        // tab therefore go with no snapshot and no undo path, so the confirm has
        // to name them instead of promising a reversal that only covers saves.
        description={
          confirm
            ? `The page will be rolled back to "${confirm.name || "Untitled"}" (${statusLabel(confirm.status)}). Only saved content is snapshotted, so restoring is reversible — but any edits you have not saved yet are discarded and cannot be recovered.`
            : ""
        }
        confirmLabel="Restore"
        onConfirm={async () => {
          if (confirm) await restore(confirm);
        }}
      />
    </div>
  );
}
