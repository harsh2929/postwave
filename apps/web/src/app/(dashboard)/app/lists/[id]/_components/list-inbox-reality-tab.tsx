// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Inbox reality (audience-97): seed-inbox placement evidence. Honesty rules
 * mirror the desktop tab — a pending test shows "—", never a fake 0%, and the
 * seed split always sums what the server reported. One more the desktop does
 * not state: `InboxRealityForList` accepts the list id but does not use it in
 * its query today, so the rows are the workspace's most recent tests.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowUpRight, Inbox, RefreshCw } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  INBOX_REALITY_LIMIT,
  listListInboxReality,
  type AudienceList,
  type ListInboxRealityRow,
} from "@/lib/lists-api";
import { listKeys, STALE, type RoleKey } from "@/lib/query-keys";

import { LoadFailure, Pending } from "./tab-chrome";

export function inboxPctLabel(row: ListInboxRealityRow): string {
  if (row.total_seeds <= 0) return "—";
  if (row.inbox + row.spam + row.missing === 0) return "—";
  if (!Number.isFinite(row.inbox_pct)) return "—";
  return `${Math.round(row.inbox_pct)}%`;
}

export function seedSplitLabel(row: ListInboxRealityRow): string {
  if (row.total_seeds <= 0) return "No seeds reported";
  const parts = [
    `${row.inbox.toLocaleString()} inbox`,
    `${row.spam.toLocaleString()} spam`,
    `${row.missing.toLocaleString()} missing`,
  ];
  const unreported = row.total_seeds - (row.inbox + row.spam + row.missing);
  if (unreported > 0)
    parts.push(`${unreported.toLocaleString()} not yet reported`);
  return `${parts.join(" · ")} (${row.total_seeds.toLocaleString()} seed${row.total_seeds === 1 ? "" : "s"})`;
}

function statusVariant(
  status: string,
): "success" | "destructive" | "secondary" {
  const s = status.toLowerCase();
  if (s === "completed" || s === "complete" || s === "done") return "success";
  if (s === "failed" || s === "error") return "destructive";
  return "secondary";
}

export function ListInboxRealityTab({
  list,
  tenantId,
  roleKey,
}: {
  list: AudienceList;
  tenantId: string;
  roleKey: RoleKey;
}) {
  const tests = useQuery({
    queryKey: listKeys.inboxReality(
      tenantId,
      roleKey,
      list.id,
      INBOX_REALITY_LIMIT,
    ),
    queryFn: ({ signal }) =>
      listListInboxReality(list.id, INBOX_REALITY_LIMIT, signal),
    staleTime: STALE.list,
  });
  const rows = Array.isArray(tests.data) ? tests.data : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            Seed-inbox placement tests — where the mail actually landed (inbox
            vs spam) on seed accounts. This is placement, not subscriber opens
            or clicks.
          </p>
          <p className="text-xs">
            The service currently returns the workspace&apos;s most recent
            tests; it does not yet filter them to {list.name}.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            loading={tests.isFetching}
            onClick={() => void tests.refetch()}
          >
            <RefreshCw aria-hidden className="size-4" /> Refresh
          </Button>
          <Button asChild variant="outline">
            <Link href="/app/inbox-reality">
              Open Inbox Reality <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          </Button>
        </div>
      </div>

      {tests.isPending ? (
        <Pending label="Loading inbox reality" />
      ) : tests.isError ? (
        <LoadFailure
          what="Inbox reality"
          error={tests.error}
          busy={tests.isFetching}
          onRetry={() => void tests.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No seed tests recorded yet"
          description="Results appear after a campaign runs an inbox-reality seed test and the seed accounts report back."
        />
      ) : (
        <>
          <TableContainer aria-label="Seed placement tests">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Test</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col" className="text-right">
                    Inbox %
                  </TableHead>
                  <TableHead scope="col">Run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.test_id}>
                    <TableCell className="max-w-[360px]">
                      <span
                        className="block truncate"
                        title={r.subject || r.test_id}
                      >
                        {r.subject || (
                          <span className="text-muted-foreground">
                            Test {r.test_id}
                          </span>
                        )}
                      </span>
                      <span className="block text-xs tabular-nums text-muted-foreground">
                        {seedSplitLabel(r)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(r.status)}>
                        {r.status || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="text-right tabular-nums"
                      title={
                        inboxPctLabel(r) === "—"
                          ? "No seed reports yet — the percentage appears once seeds report."
                          : `${r.inbox.toLocaleString()} of ${r.total_seeds.toLocaleString()} seeds landed in the inbox`
                      }
                    >
                      {inboxPctLabel(r)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.created_at ? <RelativeTime iso={r.created_at} /> : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {rows.length >= INBOX_REALITY_LIMIT ? (
            <p className="text-xs text-muted-foreground">
              Showing the {INBOX_REALITY_LIMIT} most recent tests (server
              limit).
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
