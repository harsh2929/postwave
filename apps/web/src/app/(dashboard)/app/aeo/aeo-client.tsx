// SPDX-License-Identifier: AGPL-3.0-only
//
// AEO Sensor — Answer Engine Optimization tracking surface. Desktop parity for
// apps/desktop/src/pages/AEOSensor.tsx.
//
// Page shape (top → bottom):
//   1. Header + "Run probe pass now" (admin) + load/contract errors.
//   2. Warning banner (server-authored) and the credentials-not-ready notice.
//   3. Headline tiles — mention rate, citation rate, volatility, AI referral.
//   4. Per-engine snapshot — latest rollup per ChatGPT / Gemini / Perplexity.
//   5. Brand setup, competitor board, prompt rotation, probe audit — each a
//      deferred chunk so the route's eager JS stays inside the bundle budget.
//
// Role gating: desktop shows every verb to every role and lets the server
// 403. Here the write verbs are gated on owner/admin through the shared
// admin-gate hook, with the reason shown, so a viewer never sends a request
// the server will refuse.
"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AdminGateNotice } from "@/components/admin-gate-notice";
import {
  ENGINE_LABEL,
  pct,
  SNAPSHOT_ENGINES,
  volatilityTone,
} from "@/components/aeo/aeo-format";
import { PageShell } from "@/components/dashboard/page-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  aeoKeys,
  getAeoSummary,
  isAeoContractError,
  listAeoProbes,
  listAeoPrompts,
  runAeoNow,
  type AEODailyRollup,
  type AEOEngine,
} from "@/lib/aeo-api";
import { apiErrorMessage } from "@/lib/api";
import { STALE } from "@/lib/query-keys";
import { useAdminGate } from "@/lib/use-admin-gate";
import { cn } from "@/lib/utils";

const PROBE_LIMIT = 50;
const WRITE_GATE_ID = "aeo-write-gate";

export const AEO_READ_ONLY_MESSAGE =
  "Only workspace owners and admins can change AEO Sensor settings, manage competitors and prompts, or run a probe pass. Your role can read the sensor but not change it.";

const AEO_NO_CREDENTIALS_NOTICE =
  "No AI engine credentials are configured yet — probe passes are recorded as skipped and the metrics above stay unmeasured. Add engine credentials to start probing.";

function PanelFallback({ title }: { title: string }) {
  return (
    <section
      className="rounded-lg border border-border bg-card p-6"
      aria-busy="true"
      role="status"
      aria-label={`Loading ${title}`}
    >
      <div className="mb-4 space-y-2">
        <div className="text-lg font-semibold">{title}</div>
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </section>
  );
}

const BrandSetupCard = dynamic(
  () => import("@/components/aeo/panels").then((m) => m.BrandSetupCard),
  { loading: () => <PanelFallback title="Brand setup" /> },
);
const CompetitorBoard = dynamic(
  () => import("@/components/aeo/panels").then((m) => m.CompetitorBoard),
  { loading: () => <PanelFallback title="Competitor comparison" /> },
);
const PromptLibrary = dynamic(
  () => import("@/components/aeo/panels").then((m) => m.PromptLibrary),
  { loading: () => <PanelFallback title="Prompt rotation" /> },
);
const ProbeAudit = dynamic(
  () => import("@/components/aeo/panels").then((m) => m.ProbeAudit),
  { loading: () => <PanelFallback title="Recent probes" /> },
);

function loadMessage(err: unknown): string {
  return isAeoContractError(err) ? err.message : apiErrorMessage(err);
}

const TONE_CLASS = {
  danger: "text-destructive-emphasis",
  warning: "text-warning-emphasis",
  ok: "text-success-emphasis",
} as const;

export function AeoSensorClient() {
  const queryClient = useQueryClient();
  const gate = useAdminGate();
  const tenantId = gate.identity?.tenant_id ?? "anon";
  const role = gate.role;
  const canWrite = gate.canWrite;
  const writeDeniedReason = canWrite ? null : AEO_READ_ONLY_MESSAGE;

  const summaryQuery = useQuery({
    queryKey: aeoKeys.summary(tenantId, role),
    queryFn: getAeoSummary,
    staleTime: STALE.dashboard,
  });
  const promptsQuery = useQuery({
    queryKey: aeoKeys.prompts(tenantId, role),
    queryFn: listAeoPrompts,
    staleTime: STALE.list,
  });
  const probesQuery = useQuery({
    queryKey: aeoKeys.probes(tenantId, role, PROBE_LIMIT),
    queryFn: () => listAeoProbes(PROBE_LIMIT),
    staleTime: STALE.list,
  });

  const invalidate = (...keys: (readonly unknown[])[]): void => {
    for (const queryKey of keys) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  const summaryKey = aeoKeys.summary(tenantId, role);
  const promptsKey = aeoKeys.prompts(tenantId, role);
  const probesKey = aeoKeys.probes(tenantId, role, PROBE_LIMIT);

  const [runOutcome, setRunOutcome] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: runAeoNow,
    onSuccess: (result) => {
      // Stub mode records every probe as "skipped" and rollups arrive with
      // sample_size=0 while probes still increments. Say so, rather than
      // implying a measurement happened.
      const measured = result.rollups.some((r) => r.sample_size > 0);
      const line = measured
        ? `Probe pass complete — ${result.probes} probes recorded.`
        : `Probe pass complete — ${result.probes} probes ran, but none reached an AI engine yet. Add engine credentials in Brand setup to start measuring.`;
      setRunOutcome(line);
      if (measured) toast.success("Probe pass complete");
      else toast.info("Probe pass complete", { description: line });
      invalidate(summaryKey, probesKey);
    },
    onError: (err: unknown) => {
      const message = loadMessage(err);
      setRunOutcome(`Probe run failed: ${message}`);
      toast.error("Probe run failed", { description: message });
    },
  });

  const summary = summaryQuery.data;
  const rollups = useMemo<AEODailyRollup[]>(
    () => (summary ? summary.latest_rollups : []),
    [summary],
  );
  const measured = rollups.some((r) => r.sample_size > 0);

  const tiles = useMemo(() => {
    const rate = (x: number | undefined): string =>
      measured ? pct(x ?? 0) : "—";
    const noSampleHint =
      "No measured sample yet — add engine credentials in Brand setup to begin probing.";
    return [
      {
        label: "Mention rate",
        value: rate(summary?.overall_mention_rate),
        hint: measured
          ? "% of AI responses that mention your brand"
          : noSampleHint,
      },
      {
        label: "Citation rate",
        value: rate(summary?.overall_citation_rate),
        hint: measured ? "% that link to your domain" : noSampleHint,
      },
      {
        label: "Volatility",
        value: measured ? (summary?.volatility_score ?? 0).toFixed(1) : "—",
        hint: "0–100; higher means more re-shuffling",
      },
      {
        label: "AI referral",
        value: rate(summary?.ai_referral_pct),
        hint: "% of archive traffic from AI crawlers",
      },
    ];
  }, [measured, summary]);

  const byEngine = useMemo(() => {
    const map = new Map<AEOEngine, AEODailyRollup>();
    for (const r of rollups) {
      if (r.engine === "_all") continue;
      if (!map.has(r.engine)) map.set(r.engine, r);
    }
    return map;
  }, [rollups]);

  const loadErrors = [
    summaryQuery.isError ? loadMessage(summaryQuery.error) : null,
    promptsQuery.isError ? loadMessage(promptsQuery.error) : null,
    probesQuery.isError ? loadMessage(probesQuery.error) : null,
  ].filter((m): m is string => m !== null);

  const runTitle = !canWrite ? (writeDeniedReason ?? undefined) : undefined;

  return (
    <PageShell>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            AEO Sensor
          </h1>
          <p className="text-sm text-muted-foreground">
            Track how ChatGPT, Gemini, and Perplexity cite your brand.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => run.mutate()}
          disabled={!canWrite || run.isPending}
          loading={run.isPending}
          title={runTitle}
          aria-describedby={canWrite ? undefined : WRITE_GATE_ID}
        >
          {run.isPending ? "Running…" : "Run probe pass now"}
        </Button>
      </header>

      <div id={WRITE_GATE_ID}>
        <AdminGateNotice gate={gate} readOnlyMessage={AEO_READ_ONLY_MESSAGE} />
      </div>

      {runOutcome ? (
        <p role="status" className="text-sm text-muted-foreground">
          {runOutcome}
        </p>
      ) : null}

      {loadErrors.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <div className="space-y-1">
            {loadErrors.map((m) => (
              <p key={m}>Couldn&apos;t load AEO Sensor data: {m}</p>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void summaryQuery.refetch();
              void promptsQuery.refetch();
              void probesQuery.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {summary?.warning_banner ? (
        <Alert variant="warning" role="status">
          <AlertDescription>{summary.warning_banner}</AlertDescription>
        </Alert>
      ) : null}
      {summary &&
      !summary.warning_banner &&
      summary.settings.credentials_status !== "ready" ? (
        <Alert variant="warning" role="status">
          <AlertDescription>{AEO_NO_CREDENTIALS_NOTICE}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="aeo-headline" className="space-y-3">
        <h2 id="aeo-headline" className="sr-only">
          Headline metrics
        </h2>
        {summaryQuery.isPending ? (
          <div
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            role="status"
            aria-label="Loading headline metrics"
            aria-busy="true"
          >
            {tiles.map((t) => (
              <Skeleton key={t.label} className="h-24 w-full" />
            ))}
          </div>
        ) : (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {tiles.map((t) => (
              <div
                key={t.label}
                className="rounded-lg border border-border bg-card p-4"
              >
                <dt className="text-xs text-muted-foreground">{t.label}</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">
                  {t.value}
                </dd>
                <dd className="mt-1 text-xs text-muted-foreground">{t.hint}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section aria-labelledby="aeo-engines" className="space-y-3">
        <h2 id="aeo-engines" className="text-lg font-semibold">
          Per-engine snapshot
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SNAPSHOT_ENGINES.map((eng) => {
            const r = byEngine.get(eng);
            return (
              <div
                key={eng}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="text-xs text-muted-foreground">
                  {ENGINE_LABEL[eng]}
                </div>
                {r ? (
                  <>
                    <div className="text-2xl font-semibold tabular-nums">
                      {pct(r.mention_rate)}
                    </div>
                    <div className="mt-1 text-xs">
                      Citation {pct(r.citation_rate)} · Sample {r.sample_size}
                    </div>
                    <div
                      className={cn(
                        "mt-1 text-xs",
                        TONE_CLASS[volatilityTone(r.volatility_score)],
                      )}
                    >
                      Volatility {r.volatility_score.toFixed(1)}
                    </div>
                  </>
                ) : (
                  <div className="mt-1 text-sm text-muted-foreground">
                    No data yet — waiting for first probe pass.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <BrandSetupCard
        settings={summary ? summary.settings : null}
        canWrite={canWrite}
        gateDescribedBy={WRITE_GATE_ID}
        writeDeniedReason={writeDeniedReason}
        onSaved={() => invalidate(summaryKey)}
      />

      <CompetitorBoard
        tenantId={tenantId}
        role={role}
        scores={summary ? summary.competitor_board : []}
        canWrite={canWrite}
        gateDescribedBy={WRITE_GATE_ID}
        writeDeniedReason={writeDeniedReason}
        onChanged={() => invalidate(summaryKey)}
      />

      <PromptLibrary
        prompts={promptsQuery.data ? promptsQuery.data : []}
        canWrite={canWrite}
        gateDescribedBy={WRITE_GATE_ID}
        writeDeniedReason={writeDeniedReason}
        onChanged={(cascade) =>
          cascade === "prompts+probes"
            ? invalidate(promptsKey, probesKey, summaryKey)
            : invalidate(promptsKey, summaryKey)
        }
      />

      <ProbeAudit
        probes={probesQuery.data ? probesQuery.data : []}
        loading={probesQuery.isPending}
      />
    </PageShell>
  );
}
