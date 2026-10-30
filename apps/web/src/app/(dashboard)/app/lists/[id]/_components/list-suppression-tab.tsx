// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Suppression (audience-96): member suppressions for this list, paged the way
 * the server pages (`?page&per_page`). Search, bulk add and reason editing
 * live in the dedicated Suppressions section, linked from the header.
 */
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ShieldOff } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
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
  listListSuppressions,
  SUPPRESSIONS_PAGE_SIZE,
  type AudienceList,
} from "@/lib/lists-api";
import { listKeys, STALE, type RoleKey } from "@/lib/query-keys";

import { LoadFailure, Pending } from "./tab-chrome";

export function ListSuppressionTab({
  list,
  tenantId,
  roleKey,
}: {
  list: AudienceList;
  tenantId: string;
  roleKey: RoleKey;
}) {
  const [page, setPage] = useState(1);
  const params = { page, perPage: SUPPRESSIONS_PAGE_SIZE };
  const suppressions = useQuery({
    queryKey: listKeys.suppressions(tenantId, roleKey, list.id, params),
    queryFn: ({ signal }) => listListSuppressions(list.id, params, signal),
    placeholderData: (previous) => previous,
    staleTime: STALE.list,
  });
  const total = suppressions.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / SUPPRESSIONS_PAGE_SIZE));
  const items = Array.isArray(suppressions.data?.items)
    ? suppressions.data.items
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Addresses suppressed for members of{" "}
          <span className="font-medium text-foreground">{list.name}</span>.
          Search, bulk add and reason editing live in Suppressions.
        </p>
        <Button asChild variant="outline">
          <Link href="/app/suppressions">
            Open Suppressions <ArrowUpRight aria-hidden className="size-4" />
          </Link>
        </Button>
      </div>

      {suppressions.isPending ? (
        <Pending label="Loading suppressions" />
      ) : suppressions.isError ? (
        <LoadFailure
          what="Suppressions"
          error={suppressions.error}
          busy={suppressions.isFetching}
          onRetry={() => void suppressions.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ShieldOff}
          title="No suppressions for this list"
          description="Bounces, complaints and manual blocks affecting members appear here as they happen."
        />
      ) : (
        <TableContainer aria-label={`${list.name} suppressions`}>
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Email</TableHead>
                <TableHead scope="col">Reason</TableHead>
                <TableHead scope="col">Source</TableHead>
                <TableHead scope="col">Suppressed</TableHead>
                <TableHead scope="col">Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((s) => (
                <TableRow key={s.email}>
                  <TableCell className="max-w-[280px] truncate" title={s.email}>
                    {s.email}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.reason || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.source || "—"}
                    {s.source_table ? (
                      <span className="block text-xs">
                        via {s.source_table}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.suppressed_at || s.created_at ? (
                      <RelativeTime iso={s.suppressed_at || s.created_at} />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.expires_at ? (
                      <RelativeTime iso={s.expires_at} />
                    ) : (
                      "Never"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {suppressions.data ? (
        <nav
          aria-label="Suppression pages"
          className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
        >
          <span>
            Page {page} of {totalPages} · {total.toLocaleString()} suppression
            {total === 1 ? "" : "s"}
          </span>
          {total > SUPPRESSIONS_PAGE_SIZE ? (
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                aria-label="Previous page"
                disabled={page <= 1 || suppressions.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-label="Next page"
                disabled={page >= totalPages || suppressions.isFetching}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
