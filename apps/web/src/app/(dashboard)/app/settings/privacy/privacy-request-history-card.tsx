// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import {
  dataExportDownloadPath,
  type PrivacyRequestRecord,
} from "@/lib/privacy-api";

/**
 * Privacy request history. Split out of the settings/privacy page so the
 * route's initial bundle stays under the dashboard budget: the card is below
 * the fold and only meaningful once the admin-scoped request list has loaded.
 * All state stays on the page; this component is presentational.
 */
export function PrivacyRequestHistoryCard({
  requestsLoading,
  identityUnavailable,
  canWrite,
  requestsError,
  refreshing,
  onRefresh,
  requests,
  filteredCount,
  pagedRequests,
  histType,
  onTypeChange,
  histStatus,
  onStatusChange,
  histSearch,
  onSearchChange,
  page,
  pageCount,
  onPreviousPage,
  onNextPage,
}: {
  requestsLoading: boolean;
  identityUnavailable: boolean;
  canWrite: boolean;
  requestsError: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  requests: PrivacyRequestRecord[];
  filteredCount: number;
  pagedRequests: PrivacyRequestRecord[];
  histType: string;
  onTypeChange: (value: string) => void;
  histStatus: string;
  onStatusChange: (value: string) => void;
  histSearch: string;
  onSearchChange: (value: string) => void;
  page: number;
  pageCount: number;
  onPreviousPage: () => void;
  onNextPage: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Privacy request history</CardTitle>
          <CardDescription>
            Track export, deletion, correction, and opt-out requests from one
            auditable status list.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canWrite || refreshing}
          onClick={() => onRefresh()}
        >
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {requestsLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : identityUnavailable ? (
          // Not "read-only": we never learned the role, so saying the list is
          // withheld by permission would be a guess.
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
          >
            Your workspace access could not be verified, so privacy request
            history was not requested. Refresh the page and try again.
          </div>
        ) : !canWrite ? (
          // The list is admin-scoped server-side, so this card is never
          // populated for anyone else. Say so — the alternative is an empty
          // state that reads as "this workspace has filed none".
          <p className="text-sm text-muted-foreground">
            Read-only — privacy request history is visible to workspace owners
            and admins outside viewer mode.
          </p>
        ) : requestsError ? (
          // A failed list normalises to [] — say the request failed instead
          // of claiming this workspace has never filed one.
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
          >
            Could not load privacy request history — this is a load failure, not
            an empty list. Use Refresh to try again.
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No privacy requests yet"
            description="Exports, deletions, and subscriber-rights requests for this workspace will appear here."
          />
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <Select
                aria-label="Filter by type"
                value={histType}
                onChange={(e) => onTypeChange(e.target.value)}
              >
                <option value="all">All types</option>
                {[...new Set(requests.map((r) => r.type))].map((t) => (
                  <option key={t} value={t}>
                    {labelRequestType(t)}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Filter by status"
                value={histStatus}
                onChange={(e) => onStatusChange(e.target.value)}
              >
                <option value="all">All statuses</option>
                {[...new Set(requests.map((r) => r.status))].map((s) => (
                  <option key={s} value={s}>
                    {s.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
              <Input
                type="search"
                placeholder="Search id or email…"
                value={histSearch}
                onChange={(e) => onSearchChange(e.target.value)}
                aria-label="Search requests"
              />
            </div>
            {pagedRequests.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No requests match these filters.
              </p>
            ) : (
              pagedRequests.map((req) => (
                <div
                  key={req.request_id}
                  className="rounded-md border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">
                      {labelRequestType(req.type)}
                    </div>
                    <Badge variant={statusVariant(req.status)}>
                      {req.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {req.region}
                    {req.subject_email ? ` · ${req.subject_email}` : ""} ·
                    opened <RelativeTime iso={req.requested_at} /> · due{" "}
                    {new Date(req.due_at).toLocaleDateString()}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {req.request_id}
                  </div>
                  {canDownloadExport(req) ? (
                    <Button
                      asChild
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                    >
                      <a href={dataExportDownloadPath(req.request_id)}>
                        Download local ZIP
                      </a>
                    </Button>
                  ) : req.type === "data_export" ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Download unavailable while this request is{" "}
                      {req.status.replaceAll("_", " ")}.
                    </p>
                  ) : null}
                </div>
              ))
            )}
            {pageCount > 1 ? (
              <div className="flex items-center justify-between pt-1 text-sm">
                <span className="text-xs text-muted-foreground">
                  Page {page} of {pageCount} · {filteredCount} requests
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={onPreviousPage}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page >= pageCount}
                    onClick={onNextPage}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function statusVariant(
  status: PrivacyRequestRecord["status"],
): "default" | "secondary" | "destructive" | "success" | "warning" {
  switch (status) {
    case "fulfilled":
      return "success";
    case "rejected":
    case "blocked_legal_hold":
    case "blocked_ownership":
      return "destructive";
    case "cancelled":
      return "secondary";
    case "appealed":
      return "warning";
    default:
      return "secondary";
  }
}

function labelRequestType(type: string): string {
  return type
    .split("_")
    .map((part) => (part[0]?.toUpperCase() ?? "") + part.slice(1))
    .join(" ");
}

function canDownloadExport(request: PrivacyRequestRecord): boolean {
  return (
    request.type === "data_export" &&
    !request.legal_hold &&
    ["queued", "verifying", "in_progress", "fulfilled"].includes(request.status)
  );
}
