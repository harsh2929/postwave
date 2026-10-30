// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Scale } from "lucide-react";

import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getBillingState } from "@/lib/billing-api";
import { whoami } from "@/lib/auth-api";
import { TIERS, PLAN_COMPARISON } from "@/lib/pricing";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { base, qk, STALE } from "@/lib/query-keys";
import { PageShell } from "@/components/dashboard/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function UpgradePage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.role ?? null;
  const billingStateKey = useMemo(
    () => [...base("billing", tenantId, role), "state"] as const,
    [role, tenantId],
  );
  const billingStateQuery = useQuery({
    queryKey: billingStateKey,
    queryFn: getBillingState,
    enabled: meQuery.isFetched,
    staleTime: STALE.detail,
  });
  const currentTier = billingStateQuery.data?.tier ?? null;
  const stateFailed = billingStateQuery.isError;

  return (
    <PageShell>
      <Breadcrumb
        className="[&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:items-center [&_a]:justify-center sm:[&_a]:min-h-0 sm:[&_a]:min-w-0"
        items={[
          { label: "Billing", href: "/app/billing" },
          { label: "Compare plans" },
        ]}
      />
      <header className="max-w-3xl">
        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <Scale className="h-4 w-4" aria-hidden />
          Moosewave plans
        </div>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight md:text-3xl">
          Compare plans
        </h1>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Monthly plans are approved for launch. Self-serve checkout is closed during production qualification, until the payment rehearsal and legal publication gates pass.
        </p>
      </header>

      {billingStateQuery.isPending ? (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border bg-muted/15 p-4"
          aria-label="Loading current plan"
        >
          <Skeleton className="h-5 w-5 rounded-full" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      ) : stateFailed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis">
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            Couldn&apos;t determine your current plan, so no card is marked
            “Current plan”.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 w-full sm:min-h-8 sm:w-auto"
            loading={billingStateQuery.isFetching}
            onClick={() => void billingStateQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}

      <section
        aria-label="Moosewave billing plans"
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
      >
        {TIERS.map((t) => {
          const isCurrent = currentTier === t.tier;
          const isSandbox = t.tier === "sandbox";
          return (
            <Card
              key={t.tier}
              className={cn(
                "flex flex-col",
                isCurrent && "border-primary shadow-sm",
              )}
            >
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle as="h2">{t.name}</CardTitle>
                    <CardDescription className="mt-1 leading-5">
                      {t.tagline}
                    </CardDescription>
                  </div>
                  {isCurrent && <Badge variant="secondary">Current plan</Badge>}
                </div>
                <div className="mt-4">
                  <span className="text-3xl font-semibold tracking-tight tabular-nums">
                    {t.price}
                  </span>
                  <span className="text-xs text-muted-foreground ml-2">
                    {t.cadence === "free"
                      ? "free"
                      : t.cadence === "monthly"
                        ? "/ month"
                        : "one-time"}
                  </span>
                  {t.perEmail !== null && (
                    <div className="mt-1 text-xs font-mono text-muted-foreground">
                      + {t.perEmail} sent
                    </div>
                  )}
                  <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                    {t.annualPrice
                      ? `${t.annualPrice} planned annually · Coming soon.`
                      : "No production sending."}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-4">
                <ul className="space-y-2 text-sm flex-1">
                  {t.features.map((f) => (
                    <li
                      key={f.label}
                      className={cn(
                        "flex gap-2 items-start",
                        !f.included && "text-muted-foreground line-through",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          f.included ? "text-success" : "text-muted-foreground",
                        )}
                      >
                        {f.included ? "✓" : "—"}
                      </span>
                      <span>{f.label}</span>
                    </li>
                  ))}
                </ul>
                {isCurrent ? (
                  <Button
                    type="button"
                    className="min-h-11 sm:min-h-9"
                    disabled
                    variant="outline"
                  >
                    Current plan
                  </Button>
                ) : isSandbox ? (
                  <Button
                    type="button"
                    className="min-h-11 sm:min-h-9"
                    disabled
                    variant="outline"
                  >
                    Sandbox available
                  </Button>
                ) : (
                  <Button
                    asChild
                    type="button"
                    variant="outline"
                    className="min-h-11 whitespace-normal text-center leading-5 sm:min-h-9"
                  >
                    <a
                      href={`mailto:sales@moosewave.com?subject=${encodeURIComponent(`Moosewave ${t.name} waitlist`)}`}
                    >
                      Join {t.name} waitlist
                    </a>
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </section>

      {/* BILL-051: side-by-side matrix so plans compare row-for-row instead of
          four self-referential checklists. */}
      <section aria-labelledby="plan-comparison" className="pt-4">
        <h2
          id="plan-comparison"
          className="mb-3 text-lg font-semibold tracking-tight"
        >
          Compare all plans
        </h2>
        <TableContainer aria-label="Plan feature comparison">
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-64">Feature</TableHead>
                {TIERS.map((t) => (
                  <TableHead key={t.tier} className="text-center">
                    {t.name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {PLAN_COMPARISON.map((row) => (
                <TableRow key={row.feature}>
                  <TableCell className="font-medium">{row.feature}</TableCell>
                  {TIERS.map((t) => {
                    const v = row.values[t.tier];
                    return (
                      <TableCell key={t.tier} className="text-center">
                        {typeof v === "boolean" ? (
                          v ? (
                            <span className="text-success" aria-label="Yes">
                              ✓
                            </span>
                          ) : (
                            <span
                              className="text-muted-foreground"
                              aria-label="No"
                            >
                              —
                            </span>
                          )
                        ) : (
                          <span className="text-sm">{v}</span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </section>

      <div className="border-t pt-5">
        <Button asChild variant="ghost" className="min-h-11 gap-2 sm:min-h-9">
          <Link href="/app/billing">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to billing
          </Link>
        </Button>
      </div>
    </PageShell>
  );
}
