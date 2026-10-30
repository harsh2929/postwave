// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Activity tab (FORM-038): the form's audit timeline — create / edit /
// publish-transition / delete events with actor + time. Reads the existing
// tenant audit log filtered to this form; forms handlers now emit form.*
// audit rows so the timeline is populated.

import { useQuery } from "@tanstack/react-query";

import { RelativeTime } from "@/components/relative-time";
import { whoami } from "@/lib/auth-api";
import { listAuditLog } from "@/lib/audit-api";
import { base, qk, STALE } from "@/lib/query-keys";

// Human labels for the actions the forms handlers emit.
const ACTION_LABELS: Record<string, string> = {
  "form.create": "Created",
  "form.update": "Edited",
  "form.delete": "Deleted",
};

export function ActivityPanel({ formId }: { formId: string }) {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;

  const activityQuery = useQuery({
    queryKey: [...base("forms", tenantId, role), "activity", formId] as const,
    queryFn: () =>
      listAuditLog({ resourceType: "form", resourceId: formId, limit: 50 }),
    enabled: meQuery.isFetched,
    staleTime: STALE.list,
  });

  if (activityQuery.isPending && !activityQuery.data) {
    return (
      <div className="space-y-2" aria-busy>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }
  if (activityQuery.error instanceof Error) {
    return (
      <p className="text-sm text-destructive">
        Could not load the activity timeline.
      </p>
    );
  }

  const rows = Array.isArray(activityQuery.data?.rows) ? activityQuery.data?.rows : [];
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No activity recorded yet. Edits, publishes, and deletions will appear
        here.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {rows.map((row) => (
        <li
          key={row.id}
          className="flex items-baseline justify-between gap-4 border-b pb-3 text-sm last:border-b-0"
        >
          <div className="min-w-0">
            <span className="font-medium">
              {ACTION_LABELS[row.action] ?? row.action}
            </span>
            <span className="text-muted-foreground">
              {" "}
              by {row.actorLabel || row.actorType || "system"}
            </span>
          </div>
          <RelativeTime
            iso={row.at}
            className="shrink-0 text-xs text-muted-foreground"
          />
        </li>
      ))}
    </ol>
  );
}
