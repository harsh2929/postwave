// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { apiErrorMessage } from "@/lib/api";
import { listRetentionActivity } from "@/lib/audit-compliance-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { base, STALE, type RoleKey } from "@/lib/query-keys";

const RETENTION_ACTIVITY_LIMIT = 200;

function displayTime(value: string): string {
  return formatWireTimestamp(value, "Not recorded", (date) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  );
}

export function RetentionActivityPanel({
  tenantId,
  role,
  enabled,
}: {
  tenantId: string;
  role: RoleKey;
  enabled: boolean;
}) {
  const activity = useQuery({
    queryKey: [
      ...base("audit-retention-activity", tenantId, role),
      RETENTION_ACTIVITY_LIMIT,
    ],
    queryFn: ({ signal }) =>
      listRetentionActivity({ limit: RETENTION_ACTIVITY_LIMIT, signal }),
    enabled,
    staleTime: STALE.list,
    retry: false,
  });

  const events = Array.isArray(activity.data?.events)
    ? activity.data.events
    : [];

  return (
    <GovernanceSection
      icon={Trash2}
      title="Retention activity"
      description="Every batch the audit-log retention sweeper deletes is itself recorded as an immutable purge event. The pre-purge Merkle root pins the tree state at the moment of deletion, so an external verifier can prove the purge happened after a known checkpoint."
    >
      {activity.isPending && enabled ? (
        <GovernanceLoading label="Loading retention activity…" rows={3} />
      ) : activity.isError ? (
        // Desktop shows this failure with no way back; a purge ledger that
        // cannot be reloaded reads as "nothing was purged", so the retry is
        // part of the answer rather than a convenience.
        <GovernanceError
          message={`Retention activity could not be loaded, so no purge history is shown. An unreadable ledger is not an empty one. ${apiErrorMessage(
            activity.error,
            "The request failed.",
          )}`}
          retrying={activity.isFetching}
          onRetry={() => void activity.refetch()}
        />
      ) : (
        <>
          <GovernanceMetrics
            columns={2}
            items={[
              {
                label: "Rows purged (last 30d)",
                value: (
                  activity.data?.totalPurgedLast30d ?? 0
                ).toLocaleString(),
                detail: "Summed across every recorded batch",
              },
              {
                label: "Purge batches recorded",
                value: events.length.toLocaleString(),
                detail: `Most recent ${RETENTION_ACTIVITY_LIMIT.toLocaleString()} batches`,
              },
            ]}
          />
          {events.length === 0 ? (
            <div className="mt-3">
              <GovernanceEmpty>
                No retention-purge events have been recorded. The sweeper runs
                on a 24-hour interval; the first batch appears here once rows
                are old enough to be deleted.
              </GovernanceEmpty>
            </div>
          ) : (
            <div
              role="region"
              aria-label="Audit-log retention purge batches"
              tabIndex={0}
              className="mt-3 min-w-0 overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-full min-w-[40rem] text-sm">
                <caption className="sr-only">
                  Audit-log retention purge batches, newest first
                </caption>
                <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      When
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Deleted rows
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      ID range
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Retention window
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Pre-purge root
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id} className="border-t">
                      <td className="px-3 py-2 align-top">
                        {displayTime(event.at)}
                      </td>
                      <td className="px-3 py-2 align-top tabular-nums">
                        {event.deletedCount.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 align-top font-mono text-xs text-muted-foreground">
                        {event.deletedIdRange || "—"}
                      </td>
                      <td className="px-3 py-2 align-top tabular-nums">
                        {event.retentionDays.toLocaleString()}d
                      </td>
                      <td
                        className="px-3 py-2 align-top font-mono text-xs text-muted-foreground"
                        title={event.beforeRootHash || undefined}
                      >
                        {event.beforeRootHash
                          ? `${event.beforeRootHash.slice(0, 12)}…`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </GovernanceSection>
  );
}
