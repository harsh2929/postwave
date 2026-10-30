// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Shadow-PII findings for ONE subscriber (desktop parity row audience-82) —
// desktop's slide-over "PII Findings" tab:
//
//   GET /api/v1/subscribers/{id}/pii-findings?page=&per_page=
//
// The route is mounted under the admin scope, so the list is requested only
// for an owner/admin session; anyone else sees the restriction stated and no
// request is made. "Inspect" opens the same finding dialog the workspace PII
// queue uses — safe field metadata, the immutable review receipt, and the
// reviewed/dismissed decision (which re-verifies admin authority itself).
// The matched value never leaves the scanner and is never shown here.

import dynamic from "next/dynamic";
import { useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Eye, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  listSubscriberPiiFindings,
  piiFindingStatusLabel,
  piiFindingTypeLabel,
  shortPiiFingerprint,
  type PiiFinding,
} from "@/lib/pii-findings-api";
import { base, qk, STALE } from "@/lib/query-keys";
import type { SubscriberAuthority } from "@/lib/subscriber-authority";

import {
  describePiiError,
  statusBadgeVariant,
} from "../../pii-findings/pii-findings-ui";

const PiiFindingDialog = dynamic(
  () =>
    import("../../pii-findings/pii-finding-dialog").then(
      (module) => module.PiiFindingDialog,
    ),
  { ssr: false },
);

export const SUBSCRIBER_PII_PAGE_SIZE = 20;

function isAdminAuthority(authority: SubscriberAuthority | null): boolean {
  return authority?.role === "owner" || authority?.role === "admin";
}

export function SubscriberPiiFindingsPanel({
  id,
  tenantId,
  role,
  authority,
}: {
  id: string;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
}) {
  const headingId = useId();
  const canAdmin = isAdminAuthority(authority);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<PiiFinding | null>(null);
  // The dialog invalidates everything under this prefix after a decision, so
  // the list below refreshes with the new receipt.
  const protectedBase = base("subscriber-pii-findings", tenantId, role);
  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    enabled: canAdmin,
  });
  const findings = useQuery({
    queryKey: [...protectedBase, id, page, SUBSCRIBER_PII_PAGE_SIZE],
    queryFn: ({ signal }) =>
      listSubscriberPiiFindings(id, {
        page,
        perPage: SUBSCRIBER_PII_PAGE_SIZE,
        signal,
      }),
    enabled: canAdmin,
    placeholderData: keepPreviousData,
    staleTime: STALE.list,
  });

  if (!canAdmin) {
    return (
      <section aria-labelledby={headingId} className="space-y-2">
        <h3 id={headingId} className="text-sm font-medium">
          Shadow-PII findings
        </h3>
        <p role="status" className="text-sm text-muted-foreground">
          Shadow-PII evidence for this subscriber is restricted to workspace
          owners and administrators, so no findings were requested.
        </p>
      </section>
    );
  }

  const result = findings.data;
  const items = Array.isArray(result?.items) ? result.items : [];
  const pages = result
    ? Math.max(1, Math.ceil(result.total / result.per_page))
    : 1;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={headingId} className="text-sm font-medium">
            Shadow-PII findings
          </h3>
          <p className="text-xs text-muted-foreground">
            Undeclared personal data the scanner detected in this
            subscriber&apos;s fields. Only field metadata and a protected
            fingerprint are shown — never the matched value.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={findings.isFetching}
          onClick={() => void findings.refetch()}
        >
          {findings.isFetching && !findings.isPending
            ? "Refreshing…"
            : "Refresh findings"}
        </Button>
      </div>

      {findings.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : findings.isError ? (
        <PiiLoadError
          error={findings.error}
          onRetry={() => void findings.refetch()}
        />
      ) : items.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-sm">
          <p className="font-medium">No PII findings recorded</p>
          <p className="mt-1 text-muted-foreground">
            This subscriber&apos;s verified finding queue is empty; that is not
            a guarantee that no personal data exists outside the
            scanner&apos;s coverage.
          </p>
        </div>
      ) : (
        <>
          <TableContainer aria-label="Shadow-PII findings for this subscriber">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Field evidence</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Detected</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((finding) => (
                  <TableRow key={finding.id} data-finding-id={finding.id}>
                    <TableCell className="min-w-40">
                      <p className="break-all font-mono text-xs font-medium">
                        {finding.field_name}
                      </p>
                      <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                        {shortPiiFingerprint(finding.fingerprint)}
                      </p>
                    </TableCell>
                    <TableCell>
                      {piiFindingTypeLabel(finding.detected_type)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {Math.round(finding.confidence * 100)}%
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(finding.status)}>
                        {piiFindingStatusLabel(finding.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatWireTimestamp(finding.created_at, "Unknown time")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!me.data}
                        onClick={() => setSelected(finding)}
                        aria-label={`Inspect ${piiFindingTypeLabel(finding.detected_type)} finding in field ${finding.field_name}`}
                      >
                        <Eye aria-hidden /> Inspect
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {result
                ? `${result.total.toLocaleString()} finding${result.total === 1 ? "" : "s"} · page ${result.page.toLocaleString()} of ${pages.toLocaleString()}`
                : null}
            </p>
            {pages > 1 ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || findings.isFetching}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= pages || findings.isFetching}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </div>
        </>
      )}

      {selected ? (
        <PiiFindingDialog
          identity={me.data ?? null}
          protectedBase={protectedBase}
          open
          initialFinding={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}

function PiiLoadError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const failure = describePiiError(error);
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
    >
      <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-2">
        <p>
          <span className="font-medium">{failure.title}.</span>{" "}
          {failure.message}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry findings
        </Button>
      </div>
    </div>
  );
}
