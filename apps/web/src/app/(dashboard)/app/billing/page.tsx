// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CreditCard,
  Download,
  FileText,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { useQuery } from "@tanstack/react-query";

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
import { PageShell } from "@/components/dashboard/page-shell";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeaderSkeleton,
  StatGridSkeleton,
} from "@/components/dashboard/skeletons";
import {
  getBillingState,
  getBillingPlanSummary,
  getInvoices,
  getLimitsUsage,
  getStripePortalURL,
  getUsage,
} from "@/lib/billing-api";
import type {
  BillingPlanSummary,
  BillingState,
  Invoice,
  UsagePoint,
} from "@/lib/billing-api";
import type { PlanUsageResource } from "@/lib/billing-types";
import { notificationPrefsApi } from "@/lib/notification-prefs-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { downloadTextFile } from "@/lib/download";
import { toCsv } from "@/lib/analytics-format";
import { formatLocaleDate } from "@/lib/format-currency";
import { TIERS } from "@/lib/pricing";
import { base, qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { ApiError } from "@/lib/api";
import {
  safeBillingRedirectURL,
  safeInvoiceDownloadURL,
} from "@/lib/safe-navigation";

const INVOICES_PER_PAGE = 12;

interface BillingOverviewData {
  state: BillingState;
  invoices: Invoice[];
  usage: UsagePoint[];
  planSummary: BillingPlanSummary;
  limits: PlanUsageResource[];
  usageThreshold: number; // BILL-038; 0 = alerts off
  limitsUnavailable: boolean;
  preferencesUnavailable: boolean;
}

async function loadBillingOverview(): Promise<BillingOverviewData> {
  const [state, invoices, usage, planSummary, limitsResult, prefsResult] =
    await Promise.all([
      getBillingState(),
      getInvoices(),
      getUsage(365),
      getBillingPlanSummary(),
      getLimitsUsage()
        .then((value) => ({ value, unavailable: false }))
        .catch(() => ({ value: { tier: "", rows: [] }, unavailable: true })),
      notificationPrefsApi
        .get()
        .then((value) => ({ value, unavailable: false }))
        .catch((error: unknown) => ({
          value: null,
          // A workspace with no preferences row yet legitimately has alerts
          // off. Other failures must not masquerade as that empty state.
          unavailable: !(error instanceof ApiError && error.status === 404),
        })),
    ]);
  return {
    state,
    invoices,
    usage,
    planSummary,
    limits: limitsResult.value.rows,
    usageThreshold: prefsResult.value?.usage_alert_threshold_pct ?? 0,
    limitsUnavailable: limitsResult.unavailable,
    preferencesUnavailable: prefsResult.unavailable,
  };
}

function UsageChart({
  points,
  range,
}: {
  points: UsagePoint[];
  range: number;
}) {
  const max = Math.max(1, ...points.map((p) => p.sent));
  const width = 720;
  const height = 160;
  const padding = { top: 10, right: 10, bottom: 24, left: 36 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const barW = Math.max(1, innerW / points.length - 1);
  return (
    <svg
      role="img"
      aria-label={`Emails sent over the last ${range} days`}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-40"
    >
      <line
        x1={padding.left}
        x2={padding.left}
        y1={padding.top}
        y2={padding.top + innerH}
        stroke="currentColor"
        strokeOpacity={0.15}
      />
      <line
        x1={padding.left}
        x2={padding.left + innerW}
        y1={padding.top + innerH}
        y2={padding.top + innerH}
        stroke="currentColor"
        strokeOpacity={0.15}
      />
      <text
        x={padding.left - 6}
        y={padding.top + 8}
        fontSize={9}
        textAnchor="end"
        fill="currentColor"
        fillOpacity={0.6}
      >
        {max.toLocaleString()}
      </text>
      <text
        x={padding.left - 6}
        y={padding.top + innerH}
        fontSize={9}
        textAnchor="end"
        fill="currentColor"
        fillOpacity={0.6}
      >
        0
      </text>
      {points.map((p, i) => {
        const h = (p.sent / max) * innerH;
        return (
          <rect
            key={p.date}
            x={padding.left + i * (innerW / points.length)}
            y={padding.top + innerH - h}
            width={barW}
            height={h}
            className="fill-primary"
            opacity={0.85}
          >
            <title>
              {p.date}: {p.sent.toLocaleString()} sent
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

function tierLabel(t: BillingState["tier"]): string {
  return TIERS.find((x) => x.tier === t)?.name ?? "—";
}

/**
 * Content-shaped skeleton matching the final billing layout (header + plan card
 * + usage grid + chart + invoices table) so the page settles in place instead
 * of snapping in from a single line of text (BILL-005).
 */
function BillingSkeleton() {
  return (
    <PageShell>
      <h1 className="sr-only">Billing</h1>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeaderSkeleton />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
      <div className="rounded-md border bg-card p-5 space-y-3">
        <Skeleton className="h-5 w-40" />
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-56 max-w-full" />
          ))}
        </div>
      </div>
      <div className="rounded-md border bg-card p-5 space-y-4">
        <Skeleton className="h-5 w-48" />
        <StatGridSkeleton count={2} className="sm:grid-cols-2" />
      </div>
      <div className="rounded-md border bg-card p-5 space-y-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
      <div className="rounded-md border bg-card p-5 space-y-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-32 w-full" />
      </div>
    </PageShell>
  );
}

export default function BillingOverviewPage() {
  const portalGuard = useRef(false);
  const portalController = useRef<AbortController | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [invoiceYear, setInvoiceYear] = useState<string>("all");
  const [invoicePage, setInvoicePage] = useState(1);
  const [usageRange, setUsageRange] = useState<30 | 90 | 365>(90);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;
  const effectiveRole = meQuery.data ? effectiveAuthRole(meQuery.data) : role;
  const canManageBilling =
    meQuery.isSuccess &&
    !meQuery.data.viewer_mode &&
    roleCanWrite(effectiveRole);
  const authorityKey = meQuery.isSuccess
    ? [
        tenantId,
        meQuery.data.user_id,
        effectiveRole ?? "none",
        meQuery.data.viewer_mode ? "viewer" : "member",
      ].join(":")
    : "unverified";
  const authorityKeyRef = useRef(authorityKey);
  useEffect(() => {
    authorityKeyRef.current = authorityKey;
    portalController.current?.abort();
    portalController.current = null;
    portalGuard.current = false;
    setPortalLoading(false);
  }, [authorityKey]);
  const billingOverviewKey = useMemo(
    () => [...base("billing", tenantId, effectiveRole), "overview"] as const,
    [effectiveRole, tenantId],
  );
  const billingQuery = useQuery({
    queryKey: billingOverviewKey,
    queryFn: loadBillingOverview,
    enabled: meQuery.isSuccess,
    staleTime: STALE.detail,
  });
  const loadError = billingQuery.isError
    ? billingQuery.error instanceof Error
      ? billingQuery.error.message
      : "Could not load billing — this is a failed request, not an empty account."
    : null;

  const hasData = Boolean(billingQuery.data);

  useEffect(() => {
    // Only toast when a BACKGROUND refetch fails while stale data is still on
    // screen. The initial-load failure already renders a full inline error
    // card below, so toasting there too would double-notify one failure
    // (BILL-007).
    if (loadError && hasData) {
      toast.error(
        "Billing data could not be refreshed. Existing data remains visible.",
      );
    }
  }, [loadError, hasData]);

  const handlePortal = async () => {
    if (portalGuard.current || !canManageBilling || !meQuery.data) return;
    const openedAuthority = authorityKey;
    const identity = meQuery.data;
    const controller = new AbortController();
    portalGuard.current = true;
    portalController.current = controller;
    setPortalLoading(true);
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      const { url } = await getStripePortalURL(controller.signal);
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthority
      )
        return;
      const target = safeBillingRedirectURL(url, "portal");
      if (!target)
        throw new Error("Billing portal returned an unsafe redirect URL.");
      window.location.assign(target);
    } catch (err) {
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthority
      )
        return;
      toast.error(
        err instanceof Error && err.message.includes("unsafe redirect")
          ? err.message
          : "The billing portal could not be opened. Try again.",
      );
    } finally {
      if (portalController.current === controller) {
        portalController.current = null;
        setPortalLoading(false);
        portalGuard.current = false;
      }
    }
  };

  if (meQuery.isError) {
    return (
      <PageShell>
        <Card role="alert" className="border-destructive/30">
          <CardHeader>
            <CardTitle as="h1" className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
              Couldn&apos;t verify billing access
            </CardTitle>
            <CardDescription>
              Billing data was not requested because the current workspace and
              role could not be resolved.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 gap-2 sm:min-h-9"
              loading={meQuery.isFetching}
              onClick={() => void meQuery.refetch()}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Try again
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  if (!billingQuery.data) {
    if (loadError) {
      return (
        <PageShell>
          <Card>
            <CardHeader>
              <CardTitle as="h1" className="flex items-center gap-2">
                <AlertTriangle
                  className="h-5 w-5 text-destructive"
                  aria-hidden
                />
                Couldn&apos;t load billing
              </CardTitle>
              <CardDescription>
                The billing request failed. No plan, usage, or invoice data is
                being inferred from this state.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                type="button"
                onClick={() => void billingQuery.refetch()}
                className="min-h-11 gap-2 sm:min-h-9"
                loading={billingQuery.isFetching}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Retry
              </Button>
            </CardContent>
          </Card>
        </PageShell>
      );
    }
    return <BillingSkeleton />;
  }

  const {
    state,
    invoices,
    usage,
    planSummary,
    limits,
    usageThreshold,
    limitsUnavailable,
    preferencesUnavailable,
  } = billingQuery.data;
  // BILL-038: surface an alert when any plan resource reaches the user's
  // configured usage threshold.
  const breachedResources =
    usageThreshold > 0
      ? limits.filter((r) => r.limit > 0 && r.percent >= usageThreshold)
      : [];
  // BILL-050: the API returns up to 365 days; slice client-side to the
  // selected window so switching ranges never refetches.
  const usageCutoff = new Date(Date.now() - usageRange * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const visibleUsage = usage.filter((p) => p.date >= usageCutoff);
  const totalSentRange = visibleUsage.reduce((s, p) => s + p.sent, 0);
  const tier = state.tier;
  const tierDescriptor = TIERS.find((x) => x.tier === tier);
  const card = state.card;
  const renewalDate = planSummary.current_period_end
    ? formatLocaleDate(planSummary.current_period_end)
    : null;

  const invoiceYears = Array.from(
    new Set(invoices.map((iv) => iv.date.slice(0, 4)).filter(Boolean)),
  ).sort((a, b) => b.localeCompare(a));
  const filteredInvoices =
    invoiceYear === "all"
      ? invoices
      : invoices.filter((iv) => iv.date.startsWith(invoiceYear));
  const invoicePageCount = Math.max(
    1,
    Math.ceil(filteredInvoices.length / INVOICES_PER_PAGE),
  );
  const clampedInvoicePage = Math.min(invoicePage, invoicePageCount);
  const visibleInvoices = filteredInvoices.slice(
    (clampedInvoicePage - 1) * INVOICES_PER_PAGE,
    clampedInvoicePage * INVOICES_PER_PAGE,
  );

  const exportUsageCsv = () => {
    // These two columns are a date and an integer, so nothing here can break
    // out today — but routing every client-built CSV through the one guarded
    // builder is what keeps that true when a column is added later.
    downloadTextFile(
      `postwave-sends-${visibleUsage[0]?.date ?? "usage"}.csv`,
      `${toCsv([
        ["date", "sent"],
        ...visibleUsage.map((p) => [p.date, p.sent]),
      ])}\r\n`,
      "text/csv;charset=utf-8",
    );
  };

  return (
    <PageShell>
      {breachedResources.length > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-warning-emphasis"
        >
          <span className="font-medium">Usage alert:</span>{" "}
          {breachedResources
            .map(
              (r) => `${r.resource} at ${Math.round(r.percent)}% of its limit`,
            )
            .join(", ")}
          . You set an alert at {usageThreshold}%.{" "}
          <Link
            href="/app/settings/notifications"
            className="inline-flex min-h-11 min-w-11 items-center justify-center underline sm:min-h-0 sm:min-w-0"
          >
            Adjust
          </Link>
        </div>
      ) : null}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Billing
          </h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Plan, sending usage, invoices.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <div className="grid grid-cols-1 gap-2 sm:flex">
            <Button
              asChild
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
            >
              <Link href="/app/billing/upgrade">Compare plans</Link>
            </Button>
            {canManageBilling ? (
              <Button
                type="button"
                className="min-h-11 sm:min-h-9"
                onClick={handlePortal}
                loading={portalLoading}
              >
                Manage in Stripe
              </Button>
            ) : null}
          </div>
          <p className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground sm:justify-end">
            <CreditCard className="h-3.5 w-3.5" aria-hidden />
            {card ? (
              <span>
                <span className="break-words capitalize">{card.brand}</span>{" "}
                ending {card.last4}
              </span>
            ) : (
              <span>No payment card is visible on this account</span>
            )}
          </p>
          {!canManageBilling && !meQuery.isPending ? (
            <p className="text-xs text-muted-foreground">
              Only workspace owners and admins can open the billing portal.
            </p>
          ) : null}
        </div>
      </header>

      {limitsUnavailable || preferencesUnavailable ? (
        <div
          role="status"
          className="rounded-md border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-warning-emphasis"
        >
          Usage-alert evaluation is incomplete because{" "}
          {limitsUnavailable && preferencesUnavailable
            ? "limits and notification preferences could not be loaded"
            : limitsUnavailable
              ? "current limit usage could not be loaded"
              : "notification preferences could not be loaded"}
          . Plan and invoice data below are still current.
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="flex items-center gap-2">
            Current plan
            <Badge variant="secondary">{tierLabel(tier)}</Badge>
          </CardTitle>
          <CardDescription>
            {tierDescriptor?.tagline ??
              "No catalog summary is available for this tier."}
            {tierDescriptor
              ? " Catalog copy is informational; your approved order and billing record control."
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
            {tierDescriptor?.features
              .filter((f) => f.included)
              .map((f) => (
                <li
                  key={f.label}
                  className="flex gap-2 items-start before:content-['✓'] before:text-success"
                >
                  <span>{f.label}</span>
                </li>
              ))}
          </ul>
          {renewalDate ? (
            <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t pt-4 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Renews on</dt>
                <dd className="font-medium tabular-nums">{renewalDate}</dd>
              </div>
            </dl>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">Plan usage and limits</CardTitle>
          <CardDescription>
            Live workspace usage measured by the same limits that gate writes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {planSummary.resources.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
              No metered resources are configured on this plan yet. Usage limits
              appear here once your workspace starts recording measured
              activity.
            </p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {planSummary.resources.map((resource) => (
                <div
                  key={resource.resource}
                  className="space-y-2 rounded-md border p-3"
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words font-medium">
                      {planResourceLabel(resource.resource)}
                    </span>
                    <span
                      className={`shrink-0 tabular-nums ${
                        resource.exceeded
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }`}
                    >
                      {resource.current.toLocaleString()} /{" "}
                      {resource.limit > 0
                        ? resource.limit.toLocaleString()
                        : "Not included"}
                    </span>
                  </div>
                  {resource.limit > 0 ? (
                    <Progress
                      value={Math.min(100, resource.percent)}
                      aria-label={`${planResourceLabel(resource.resource)} usage`}
                    />
                  ) : null}
                  {resource.exceeded ? (
                    <p className="text-xs text-destructive">
                      Plan limit exceeded.
                    </p>
                  ) : resource.limit > 0 && resource.percent >= 80 ? (
                    <p className="text-xs text-warning-emphasis">
                      {Math.max(
                        0,
                        resource.limit - resource.current,
                      ).toLocaleString()}{" "}
                      remaining.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {planSummary.sends_projection?.on_track_to_exceed ? (
            <div className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis">
              At the current pace, monthly sends are projected to reach{" "}
              {planSummary.sends_projection.projected_end_of_period.toLocaleString()}
              {planSummary.sends_projection.projected_exceed_date
                ? ` and cross the plan limit around ${formatLocaleDate(planSummary.sends_projection.projected_exceed_date)}`
                : ""}
              .
            </div>
          ) : null}
          {planSummary.resources.some(
            (resource) =>
              resource.exceeded ||
              (resource.limit > 0 && resource.percent >= 80),
          ) ? (
            <Button asChild type="button" className="min-h-11 sm:min-h-9">
              <Link href="/app/billing/upgrade">Compare higher limits</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">
            {tier === "sandbox"
              ? "Upgrade for production sending"
              : "Compare plans"}
          </CardTitle>
          <CardDescription>
            {tier === "sandbox"
              ? "You're in the free Sandbox. Choose a production plan before sending to real recipients."
              : "Review the finite profile, sending, seat, AI, and report allowances for Launch, Growth, and Scale."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            asChild
            type="button"
            className="min-h-11 whitespace-normal text-center leading-5 sm:min-h-9"
          >
            <Link href="/app/billing/upgrade">
              {tier === "sandbox"
                ? "Choose a production plan"
                : "Review plan allowances"}
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle as="h2">Last {usageRange} days</CardTitle>
            <CardDescription>
              {totalSentRange.toLocaleString()} emails sent across the period.
            </CardDescription>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Select
              value={String(usageRange)}
              onChange={(e) =>
                setUsageRange(Number(e.target.value) as 30 | 90 | 365)
              }
              aria-label="Usage window"
              className="w-full sm:w-28"
            >
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">365 days</option>
            </Select>
            {visibleUsage.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 w-full gap-1.5 sm:min-h-8 sm:w-auto"
                onClick={exportUsageCsv}
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                Export CSV
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {visibleUsage.length > 0 ? (
            <UsageChart points={visibleUsage} range={usageRange} />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No sent-email events have been recorded in the last {usageRange}{" "}
              days.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle as="h2">Invoices</CardTitle>
            <CardDescription>
              Stripe invoices. A download appears only when a safe receipt URL
              is available.
            </CardDescription>
          </div>
          {invoiceYears.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="sr-only">Filter invoices by year</span>
              <Select
                aria-label="Filter invoices by year"
                className="h-11 w-full sm:h-8 sm:w-28"
                value={invoiceYear}
                onChange={(e) => {
                  setInvoiceYear(e.target.value);
                  setInvoicePage(1);
                }}
              >
                <option value="all">All years</option>
                {invoiceYears.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No invoices yet"
              description="Invoices appear here once Stripe issues your first charge. Receipt downloads appear when Stripe returns a safe URL."
            />
          ) : (
            <div className="space-y-3">
              <TableContainer aria-label="Billing invoices">
                <Table className="min-w-[520px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Invoice</TableHead>
                      <TableHead scope="col">Date</TableHead>
                      <TableHead scope="col">Amount</TableHead>
                      <TableHead scope="col">Status</TableHead>
                      <TableHead scope="col" className="text-right">
                        Receipt
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleInvoices.map((iv) => {
                      const downloadUrl = safeInvoiceDownloadURL(
                        iv.downloadUrl,
                      );
                      return (
                        <TableRow key={iv.id}>
                          <TableCell className="font-mono text-xs">
                            {iv.number || "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {formatLocaleDate(iv.date)}
                          </TableCell>
                          <TableCell className="font-mono">
                            {iv.amount}
                          </TableCell>
                          <TableCell className="capitalize">
                            {iv.status === "paid" ? (
                              <Badge variant="success">Paid</Badge>
                            ) : (
                              <Badge variant="secondary">{iv.status}</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {downloadUrl ? (
                              <a
                                href={downloadUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex min-h-11 items-center text-sm underline underline-offset-2 hover:opacity-80 sm:min-h-0"
                              >
                                Download
                              </a>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Unavailable
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
              {invoicePageCount > 1 ? (
                <nav
                  aria-label="Invoice pages"
                  className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
                >
                  <span>
                    Page {clampedInvoicePage} of {invoicePageCount} ·{" "}
                    {filteredInvoices.length}{" "}
                    {filteredInvoices.length === 1 ? "invoice" : "invoices"}
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      disabled={clampedInvoicePage === 1}
                      onClick={() => setInvoicePage((p) => Math.max(1, p - 1))}
                    >
                      Previous
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      disabled={clampedInvoicePage >= invoicePageCount}
                      onClick={() =>
                        setInvoicePage((p) => Math.min(invoicePageCount, p + 1))
                      }
                    >
                      Next
                    </Button>
                  </div>
                </nav>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

function planResourceLabel(resource: string): string {
  const explicit: Record<string, string> = {
    ai_credits: "AI credits",
    api_operations: "API operations",
    asset_storage: "Asset storage (MiB)",
    automation_executions: "Automation executions",
    tracked_events: "Tracked events",
  };
  if (explicit[resource]) return explicit[resource];
  return resource
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
