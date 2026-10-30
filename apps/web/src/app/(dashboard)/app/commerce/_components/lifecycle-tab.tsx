// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Commerce → Lifecycle.
 *
 * Per-store lifecycle health (commerce-25/26):
 *   - GET  …/lifecycle/report   — subscription totals by status, commerce
 *     events over the last 30 days, and the notify backlog. Refreshable.
 *   - POST …/lifecycle/evaluate — admin only, behind a confirm: it walks the
 *     store's pending back-in-stock and price-drop subscriptions and may flip
 *     them to eligible.
 *
 * Eligibility is a workflow state, not delivery evidence: nothing on this tab
 * proves a notification was queued, sent, or delivered. Two answers a 200 can
 * carry that are NOT rendered as totals — a shape the handler does not
 * document, and a report belonging to another store — are refused by
 * `lifecycleReportRefusal` before anything numeric reaches the page.
 *
 * Desktop reference: apps/desktop/src/components/commerce/LifecycleTab.tsx.
 */

import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
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
import { apiErrorMessage } from "@/lib/api";
import { commerceApi, type CommerceLifecycleReport } from "@/lib/commerce-api";
import { formatCommerceTime } from "@/lib/commerce-catalog-helpers";
import {
  evaluateSummaryMessage,
  eventCounts30d,
  eventLabel,
  isEvaluationAcknowledgement,
  LIFECYCLE_EVALUATE_FAILURE,
  LIFECYCLE_LOAD_FAILURE,
  lifecycleReportRefusal,
  lifecycleRows,
} from "@/lib/commerce-lifecycle-helpers";
import { STALE } from "@/lib/query-keys";

import {
  commerceKeys,
  type CommerceAdminOperation,
  type CommerceWorkspaceContext,
} from "./commerce-context";
import { CommerceErrorNotice } from "./commerce-primitives";
import {
  StoreScopeSelect,
  storeRouteFailureMessage,
  useStoreScope,
} from "./store-scope";

const EVIDENCE_BOUNDARY =
  "Eligibility was updated. This acknowledgement is not notification or delivery evidence; verify the downstream automation run and the provider delivery record.";

export function LifecycleTab({ ctx }: { ctx: CommerceWorkspaceContext }) {
  const id = useId();
  const queryClient = useQueryClient();
  const scope = useStoreScope(ctx);
  const stores = scope.integrations;
  const storeId = scope.selectedId;
  const evaluateButtonRef = useRef<HTMLButtonElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const reportKey = commerceKeys.lifecycleReport(ctx.scopeKey, storeId);
  const reportQuery = useQuery({
    queryKey: reportKey,
    queryFn: () => commerceApi.lifecycleReport(storeId),
    enabled: ctx.ready && storeId !== "",
    staleTime: STALE.detail,
  });
  const answer = reportQuery.data;
  // A trustworthy answer or nothing: the refusal replaces the totals rather
  // than annotating them, because a partly-rendered report is still numbers.
  const refusal =
    answer === undefined ? null : lifecycleReportRefusal(answer, storeId);
  const report =
    answer !== undefined && refusal === null
      ? (answer as CommerceLifecycleReport)
      : null;

  const evaluate = useMutation({
    mutationFn: async (operation: CommerceAdminOperation) => {
      try {
        await ctx.authorizeAdminOperation(operation);
        return await commerceApi.evaluateLifecycle(storeId, {
          signal: operation.controller.signal,
          idempotencyKey: operation.idempotencyKey,
        });
      } finally {
        ctx.finishAdminOperation(operation);
      }
    },
  });
  const evaluating = evaluate.isPending;

  const runEvaluation = async () => {
    const operation = ctx.beginAdminOperation();
    if (!operation) return;
    let acknowledgement: unknown;
    try {
      acknowledgement = await evaluate.mutateAsync(operation);
    } catch (error) {
      // Thrown so the confirm renders the server's own refusal and stays
      // open; a failed evaluation changed nothing to report.
      throw new Error(apiErrorMessage(error, LIFECYCLE_EVALUATE_FAILURE));
    }
    // The write may have landed either way, so the report is re-read before
    // anything is said about it.
    await queryClient.invalidateQueries({ queryKey: reportKey });
    if (isEvaluationAcknowledgement(acknowledgement)) {
      toast.success(evaluateSummaryMessage(acknowledgement), {
        description: EVIDENCE_BOUNDARY,
      });
      return;
    }
    toast.error("Evaluation acknowledgement incomplete", {
      description:
        "The evaluation may have completed, but its counters could not be verified. The report has been refreshed; review it before running evaluation again.",
    });
  };

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={`${id}-heading`} className="text-lg font-semibold">
            Lifecycle health
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Stored subscription state and recent commerce events for one
            connected store. Eligibility is a workflow state — not proof that a
            notification was queued, sent, or delivered.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={storeId === "" || evaluating}
            onClick={() => void reportQuery.refetch()}
            loading={reportQuery.isFetching}
          >
            Refresh report
          </Button>
          {ctx.canAdmin ? (
            <Button
              ref={evaluateButtonRef}
              type="button"
              size="sm"
              disabled={storeId === "" || evaluating}
              onClick={() => setConfirmOpen(true)}
              loading={evaluating}
            >
              Evaluate eligibility
            </Button>
          ) : null}
        </div>
      </div>

      <StoreScopeSelect
        id={`${id}-store`}
        scope={scope}
        disabled={!ctx.ready || evaluating}
        help="The report and the evaluator both act on the selected store only."
      />

      {scope.query.isError ? (
        <CommerceErrorNotice
          error={scope.query.error}
          label="connected stores"
          stale={stores !== null}
          retrying={scope.query.isFetching}
          onRetry={() => void scope.query.refetch()}
          describe={storeRouteFailureMessage}
        />
      ) : null}

      {stores === null ? (
        scope.query.isError ? null : (
          <div
            className="space-y-3"
            aria-busy="true"
            aria-label="Loading connected stores"
          >
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )
      ) : stores.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="Lifecycle health needs a store integration"
          description="The evaluator reads inventory and price history from a connected store. Connect one first — Connect Shopify above, or the Integrations page."
        />
      ) : (
        <>
          <p
            role="note"
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          >
            These totals summarize stored lifecycle records for{" "}
            <strong className="text-foreground">{scope.label}</strong>.
            “Awaiting notification” is a backlog of records, not a send queue:
            confirm the automation run and the provider delivery log before
            treating any message as dispatched.
            {ctx.canAdmin
              ? ""
              : " You can inspect and refresh this report; an owner or admin outside viewer mode runs eligibility evaluation."}
          </p>

          {reportQuery.isError ? (
            <CommerceErrorNotice
              error={reportQuery.error}
              label="lifecycle report"
              // A failed REFRESH leaves the previous report on screen; say so,
              // so its totals are not read as current.
              stale={Boolean(report)}
              retrying={reportQuery.isFetching}
              onRetry={() => void reportQuery.refetch()}
              describe={(error) =>
                apiErrorMessage(error, LIFECYCLE_LOAD_FAILURE)
              }
            />
          ) : refusal ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span>{refusal}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void reportQuery.refetch()}
                  loading={reportQuery.isFetching}
                >
                  Retry lifecycle report
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {report ? (
            <LifecycleReportView report={report} storeLabel={scope.label} />
          ) : reportQuery.isPending ? (
            <div
              className="space-y-3"
              aria-busy="true"
              aria-label={`Loading lifecycle report for ${scope.label}`}
            >
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : null}
        </>
      )}

      {ctx.canAdmin ? (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          returnFocusRef={evaluateButtonRef}
          title={`Evaluate eligibility for ${scope.label}?`}
          description={
            <span className="space-y-2 block">
              <span className="block">
                Pending back-in-stock and price-drop subscriptions for this
                store are checked against current inventory and price history;
                qualifying records may become eligible to notify.
              </span>
              <span className="block">
                Candidate count, channel impact, and inventory freshness are not
                returned before this runs, and a completed evaluation does not
                prove any notification was queued, sent, or delivered.
              </span>
            </span>
          }
          confirmLabel="Run evaluation"
          confirmVariant="default"
          onConfirm={runEvaluation}
        />
      ) : null}
    </section>
  );
}

function LifecycleReportView({
  report,
  storeLabel,
}: {
  report: CommerceLifecycleReport;
  storeLabel: string;
}) {
  const id = useId();
  const rows = lifecycleRows(report);
  const events = eventCounts30d(report);

  return (
    <div className="space-y-4">
      <TableContainer
        aria-label={`Lifecycle subscription status for ${storeLabel}`}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lifecycle</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Status breakdown</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.kind}>
                <TableCell className="font-medium">{row.kind}</TableCell>
                <TableCell className="tabular-nums">
                  {row.total.toLocaleString()}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {row.byStatus}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <dl
        aria-label="Lifecycle report summary"
        className="grid gap-3 sm:grid-cols-3"
      >
        <div className="rounded-md border border-border bg-card p-3">
          <dt className="text-xs text-muted-foreground">
            Eligible in last 30 days
          </dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">
            {report.eligible_last_30_days.toLocaleString()}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-card p-3">
          <dt className="text-xs text-muted-foreground">
            Awaiting notification
          </dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">
            {report.notified_pending.toLocaleString()}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-card p-3">
          <dt className="text-xs text-muted-foreground">Report generated</dt>
          <dd className="mt-1 text-sm font-semibold">
            {formatCommerceTime(report.generated_at)}
          </dd>
        </div>
      </dl>

      <section
        aria-labelledby={`${id}-events`}
        className="rounded-md border border-border bg-card p-4"
      >
        <h3 id={`${id}-events`} className="text-sm font-semibold">
          Commerce events · last 30 days
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Recorded event volume for this store. A count does not imply an
          automation or a notification ran.
        </p>
        {events.length > 0 ? (
          <ul
            aria-label="Commerce event counts in the last 30 days"
            className="mt-3 flex flex-wrap gap-2"
          >
            {events.map((event) => (
              <li key={event.event}>
                <Badge variant="secondary">
                  {eventLabel(event.event)}{" "}
                  <span className="ml-1 font-semibold tabular-nums">
                    {event.count.toLocaleString()}
                  </span>
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No commerce events recorded in the last 30 days.
          </p>
        )}
      </section>
    </div>
  );
}
