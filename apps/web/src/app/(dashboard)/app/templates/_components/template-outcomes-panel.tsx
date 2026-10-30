// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api";
import { getABResults, type ABResultsResponse } from "@/lib/ab-results-api";
import type { CampaignReport } from "@/lib/campaign-analytics-api";
import { summarizeTemplateOutcomes } from "@/lib/template-outcomes";

interface SourceCampaign {
  id: string;
  name: string;
}

const REPORT_LIMIT = 8;

/** Reports are fetched only on request, capped to keep template detail fast. */
export function TemplateOutcomesPanel({ campaigns }: { campaigns: SourceCampaign[] }) {
  const [reports, setReports] = useState<Array<{ campaign: SourceCampaign; report: CampaignReport }> | null>(null);
  const [failed, setFailed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [experiments, setExperiments] = useState<Array<{ campaign: SourceCampaign; result: ABResultsResponse }> | null>(null);
  const [experimentFailures, setExperimentFailures] = useState(0);
  const [experimentsBusy, setExperimentsBusy] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const candidates = campaigns.slice(0, REPORT_LIMIT);

  useEffect(() => {
    const currentRequest = requestRef;
    return () => {
      currentRequest.current?.abort();
      currentRequest.current = null;
    };
  }, []);

  async function load() {
    if (busy || requestRef.current) return;
    setBusy(true);
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const { getCampaignReport } = await import("@/lib/campaign-analytics-api");
      const settled = await Promise.allSettled(candidates.map((campaign) =>
        getCampaignReport(campaign.id, { signal: controller.signal, maxAttempts: 1 }),
      ));
      if (controller.signal.aborted && requestRef.current !== controller) return;
      const loaded: Array<{ campaign: SourceCampaign; report: CampaignReport }> = [];
      let errors = 0;
      settled.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value.campaign_id === candidates[index].id) {
          loaded.push({ campaign: candidates[index], report: result.value });
        } else {
          errors += 1;
        }
      });
      setReports(loaded);
      setFailed(errors);
    } finally {
      clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  }

  async function loadExperiments() {
    if (experimentsBusy) return;
    setExperimentsBusy(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const settled = await Promise.allSettled(candidates.map((campaign) =>
        getABResults(campaign.id, "click_rate", controller.signal),
      ));
      const found: Array<{ campaign: SourceCampaign; result: ABResultsResponse }> = [];
      let failures = 0;
      settled.forEach((entry, index) => {
        if (entry.status === "fulfilled" && entry.value.campaign_id === candidates[index].id && entry.value.variants.length >= 2) {
          found.push({ campaign: candidates[index], result: entry.value });
        } else if (entry.status === "rejected" && (!isApiError(entry.reason) || entry.reason.status !== 404)) {
          failures += 1;
        }
      });
      setExperiments(found);
      setExperimentFailures(failures);
    } finally {
      clearTimeout(timeout);
      setExperimentsBusy(false);
    }
  }

  const summary = reports ? summarizeTemplateOutcomes(reports.map((entry) => entry.report)) : null;
  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Observed campaign outcomes</h3>
          <p className="text-xs text-muted-foreground">
            Reports from up to {REPORT_LIMIT} sent campaigns using a copy of this template. Later template edits do not change those campaigns.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? "Loading reports…" : reports ? "Refresh outcomes" : "Load outcomes"}
        </Button>
      </div>
      {reports ? (
        <div aria-live="polite" className="space-y-2">
          {failed > 0 ? (
            <p className="text-xs text-amber-800" role="status">
              {failed} report{failed === 1 ? "" : "s"} unavailable; totals below exclude them.
            </p>
          ) : null}
          {summary?.campaigns ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <OutcomeMetric label="Delivered" value={summary.delivered.toLocaleString()} />
                <OutcomeMetric label="Unique opens" value={summary.uniqueOpens.toLocaleString()} />
                <OutcomeMetric label="Unique clicks" value={summary.uniqueClicks.toLocaleString()} />
                <OutcomeMetric label="Click rate" value={summary.clickRate === null ? "—" : `${summary.clickRate.toFixed(1)}%`} />
              </div>
              <p className="text-xs text-muted-foreground">
                Across {summary.campaigns} report{summary.campaigns === 1 ? "" : "s"}. Rates use delivered as the denominator; opens and clicks are unique within each campaign, not across campaigns. Tracking and audience differences affect these numbers, so they do not measure the template’s causal impact.
              </p>
              <ul className="space-y-1 text-xs">
                {reports.map(({ campaign, report }) => (
                  <li key={campaign.id} className="flex justify-between gap-3">
                    <Link className="truncate underline-offset-2 hover:underline" href={`/app/campaigns/${campaign.id}/analytics`}>
                      {campaign.name || "Untitled campaign"}
                    </Link>
                    <span className="shrink-0 text-muted-foreground">{report.delivered.toLocaleString()} delivered · {report.unique_clicks.toLocaleString()} clicked</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No campaign reports are available yet.</p>
          )}
        </div>
      ) : null}
      <div className="space-y-2 border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-medium">Controlled experiment evidence</h4>
            <p className="text-xs text-muted-foreground">Look for A/B tests among these campaigns. A subject-line test does not prove a template design is better.</p>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={experimentsBusy} onClick={() => void loadExperiments()}>
            {experimentsBusy ? "Checking tests…" : experiments ? "Refresh tests" : "Find A/B tests"}
          </Button>
        </div>
        {experiments ? <div aria-live="polite" className="space-y-2 text-xs">
          {experimentFailures ? <p role="status" className="text-amber-800">{experimentFailures} test result{experimentFailures === 1 ? "" : "s"} unavailable; evidence may be incomplete.</p> : null}
          {!experiments.length ? <p className="text-muted-foreground">No completed A/B results found among the sampled campaigns.</p> : null}
          {experiments.map(({ campaign, result }) => <div key={campaign.id} className="rounded-md border bg-muted/20 p-3">
            <Link href={`/app/campaigns/${campaign.id}/ab-results`} className="font-medium underline-offset-2 hover:underline">{campaign.name || "Untitled campaign"} · inspect A/B methodology</Link>
            <p className="mt-1 text-muted-foreground">{result.variants.map((variant) => `${variant.variant_label || `Variant ${variant.variant_index + 1}`}: ${variant.sent > 0 ? `${((variant.hits / variant.sent) * 100).toFixed(1)}%` : "—"} clicks (${variant.sent.toLocaleString()} sent)`).join(" · ")}</p>
            <p className="mt-1 text-muted-foreground">{result.winner?.method === "not_decided" || !result.winner ? "No winner decided." : `Reported winner: variant ${result.winner.variant_index + 1} (${result.winner.method}).`} Check assignment, sample size, and what was actually varied before applying learnings.</p>
          </div>)}
        </div> : null}
      </div>
    </div>
  );
}

function OutcomeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-semibold tabular-nums">{value}</p>
    </div>
  );
}
