// SPDX-License-Identifier: AGPL-3.0-only
//
// The overview's Members card. It answers "who is in this segment?" live, from
// GET /segments/{id}/members, the moment the segment exists. Snapshots stay
// available underneath, for freezing who matched at a moment in time; they are
// no longer the only way to see anyone.
"use client";

import * as React from "react";
import Link from "next/link";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { base, STALE } from "@/lib/query-keys";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  createSnapshot,
  getSegmentMembers,
  getSnapshotMembers,
  listSnapshots,
} from "@/lib/segments-api";

export const MEMBERS_PER_PAGE = 50;

export interface MembersSectionProps {
  segmentId: string;
  includeArchived: boolean;
  tenantId: string;
  role: string | null;
  principalKey: string;
  authority: SubscriberAuthority | null;
  enabled: boolean;
}

export function MembersSection({
  segmentId,
  includeArchived,
  tenantId,
  role,
  principalKey,
  authority,
  enabled,
}: MembersSectionProps) {
  const [page, setPage] = React.useState(1);
  const membersQuery = useQuery({
    queryKey: [
      ...base("segment-members", tenantId, role),
      principalKey,
      segmentId,
      page,
    ],
    enabled: enabled && Boolean(segmentId),
    queryFn: () => getSegmentMembers(segmentId, page, MEMBERS_PER_PAGE),
    staleTime: STALE.detail,
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
    retry: false,
  });
  const members = membersQuery.data;
  const total = members?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / MEMBERS_PER_PAGE));
  const first = total === 0 ? 0 : (page - 1) * MEMBERS_PER_PAGE + 1;
  const last = Math.min(page * MEMBERS_PER_PAGE, total);
  // The segment can shrink between pages; never strand the reader past the end.
  React.useEffect(() => {
    if (members && page > pageCount) setPage(pageCount);
  }, [members, page, pageCount]);

  return (
    <section
      aria-labelledby="segment-members-heading"
      className="rounded-lg border bg-card p-4"
    >
      <h2 id="segment-members-heading" className="text-sm font-medium">
        Members
      </h2>
      <p className="text-xs text-muted-foreground">
        Everyone who matches this segment right now
        {includeArchived ? ", archived subscribers included" : ""}. Newest
        subscribers first.
      </p>

      <div className="mt-3" aria-busy={membersQuery.isFetching}>
        {membersQuery.isPending ? (
          <div className="space-y-1" role="status" aria-label="Loading members">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : membersQuery.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {membersErrorMessage(membersQuery.error)}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void membersQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">
            No one matches this segment right now.
          </p>
        ) : (
          <>
            <ul className="max-h-80 divide-y overflow-y-auto rounded-md border text-sm">
              {(Array.isArray(members?.items) ? members.items : []).map((m) => (
                <li
                  key={m.subscriber_id}
                  className="flex items-center justify-between gap-2 px-3 py-1.5"
                >
                  <Link
                    href={`/app/subscribers/${encodeURIComponent(m.subscriber_id)}`}
                    className="min-w-0 truncate underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                  >
                    {m.email}
                  </Link>
                  {m.archived ? (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Archived
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p
                className="text-xs tabular-nums text-muted-foreground"
                aria-live="polite"
              >
                Showing {first.toLocaleString()}–{last.toLocaleString()} of{" "}
                {total.toLocaleString()} member{total === 1 ? "" : "s"}
              </p>
              {pageCount > 1 ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Previous page of members"
                    disabled={page <= 1 || membersQuery.isFetching}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden />
                  </Button>
                  <span className="px-1 text-xs tabular-nums text-muted-foreground">
                    Page {page} of {pageCount.toLocaleString()}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Next page of members"
                    disabled={page >= pageCount || membersQuery.isFetching}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      <SnapshotsPanel
        segmentId={segmentId}
        tenantId={tenantId}
        role={role}
        principalKey={principalKey}
        authority={authority}
        enabled={enabled}
      />
    </section>
  );
}

function membersErrorMessage(error: unknown): string {
  // 422: the stored rules no longer evaluate; the server says which way.
  if (error instanceof ApiError && error.status === 422 && error.message) {
    return error.message;
  }
  return "Couldn't load the members of this segment.";
}

/**
 * Snapshots freeze who matched at a moment: useful before a send, when the
 * audience must not drift. Secondary to the live list above.
 */
function SnapshotsPanel({
  segmentId,
  tenantId,
  role,
  principalKey,
  authority,
  enabled,
}: Omit<MembersSectionProps, "includeArchived">) {
  const [snapshotId, setSnapshotId] = React.useState<string | null>(null);
  const [capturing, setCapturing] = React.useState(false);
  const captureRef = React.useRef(false);
  const queryClient = useQueryClient();
  const snapshotsKey = [
    ...base("segment-snapshots", tenantId, role),
    principalKey,
    segmentId,
  ];

  const snapshotsQuery = useQuery({
    queryKey: snapshotsKey,
    enabled: enabled && Boolean(segmentId),
    queryFn: () => listSnapshots(segmentId),
    staleTime: STALE.detail,
    retry: false,
  });
  const snapshots = Array.isArray(snapshotsQuery.data)
    ? snapshotsQuery.data
    : [];
  const activeSnapshotId = snapshotId ?? snapshots[0]?.id ?? null;

  const snapshotMembersQuery = useQuery({
    queryKey: [
      ...base("snapshot-members", tenantId, role),
      principalKey,
      activeSnapshotId ?? "",
    ],
    enabled: enabled && Boolean(activeSnapshotId),
    queryFn: () => getSnapshotMembers(activeSnapshotId!, 1, 50),
    staleTime: STALE.detail,
    retry: false,
  });

  const capture = async () => {
    if (!authority || captureRef.current) return;
    const intentSegmentId = segmentId;
    captureRef.current = true;
    setCapturing(true);
    try {
      await reauthorizeSubscriberMutation(authority);
      const snap = await createSnapshot(intentSegmentId);
      await queryClient.invalidateQueries({
        queryKey: [
          ...base("segment-snapshots", tenantId, role),
          principalKey,
          intentSegmentId,
        ],
      });
      setSnapshotId(snap.id);
      toast.success(
        `Snapshot saved: ${snap.count.toLocaleString()} member${snap.count === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't save the snapshot.",
      );
    } finally {
      captureRef.current = false;
      setCapturing(false);
    }
  };

  const snapshotMembers = snapshotMembersQuery.data;

  return (
    <div className="mt-4 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium">Snapshots</h3>
          <p className="text-xs text-muted-foreground">
            Freeze who matches now, to keep a record that doesn&apos;t change.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {snapshots.length > 0 ? (
            <Select
              aria-label="Snapshot"
              value={activeSnapshotId ?? ""}
              onChange={(e) => setSnapshotId(e.target.value)}
              className="max-w-[16rem]"
            >
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {new Date(s.evaluated_at).toLocaleString()} ·{" "}
                  {s.count.toLocaleString()}
                </option>
              ))}
            </Select>
          ) : null}
          {authority ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void capture()}
              disabled={capturing}
            >
              {capturing ? "Saving snapshot…" : "Freeze a snapshot"}
            </Button>
          ) : null}
        </div>
      </div>

      {snapshotsQuery.isError ? (
        // The list request failed, so `snapshots` is empty for a reason that
        // has nothing to do with this segment. "No snapshots yet" would send
        // the operator to capture a duplicate.
        <div className="mt-2 space-y-2">
          <p role="alert" className="text-sm text-destructive">
            Couldn&apos;t load the snapshots of this segment.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void snapshotsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : snapshots.length === 0 ? null : snapshotMembers ? (
        <div className="mt-2">
          <p className="mb-2 text-xs text-muted-foreground">
            Showing {snapshotMembers.items.length.toLocaleString()} of{" "}
            {snapshotMembers.total.toLocaleString()} members frozen in this
            snapshot
            {snapshotMembers.sample_is_complete ? "" : " (a sample)"}.
          </p>
          <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm">
            {snapshotMembers.items.map((m) => (
              <li
                key={m.subscriber_id}
                className="px-3 py-1.5 [overflow-wrap:anywhere]"
              >
                {m.email}
              </li>
            ))}
            {snapshotMembers.items.length === 0 ? (
              <li className="px-3 py-2 text-muted-foreground">
                No one matched when this snapshot was saved.
              </li>
            ) : null}
          </ul>
        </div>
      ) : snapshotMembersQuery.isLoading ? (
        <div
          className="mt-2 space-y-1"
          role="status"
          aria-label="Loading snapshot"
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : snapshotMembersQuery.isError ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          Couldn&apos;t load the members of this snapshot.
        </p>
      ) : null}
    </div>
  );
}
