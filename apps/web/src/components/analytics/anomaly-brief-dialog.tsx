// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// "Explain this anomaly" (desktop AnomalyBriefModal). Opening the dialog
// sends ONE request —
//   POST /api/v1/analytics/anomaly-brief { metric, window_days }
// — and presents the model's reading (summary, probable causes, suggested
// actions) beside the deterministic aggregates the server computed and handed
// the model (current vs previous window, daily series, top campaigns).
//
// The endpoint is read-scoped (read:reports), so every role that can open
// Analytics can ask. Outcomes are reported as they are: an unavailable
// provider says exactly what can be known (AI_UNAVAILABLE_MESSAGE), any other
// failure renders the server's sentence, and a response whose metric/window
// does not match the question is refused rather than shown. Closing or
// retrying discards a late answer — it is never painted over a newer request.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LineChart } from "@/components/charts/line-chart";
import {
  AI_UNAVAILABLE_MESSAGE,
  getAnomalyBrief,
  type AnomalyBriefResult,
  type AnomalyMetric,
} from "@/lib/ai-compose-api";
import {
  MAX_BRIEF_NARRATIVE_LENGTH,
  safeBriefList,
  safeBriefText,
} from "@/lib/ai-brief-redaction";
import { apiErrorMessage } from "@/lib/api";
import { asRoute } from "@/lib/typed-routes";

export interface AnomalyBriefRequest {
  metric: AnomalyMetric;
  windowDays: number;
}

const BRIEF_METRICS: readonly AnomalyMetric[] = [
  "opens",
  "clicks",
  "bounces",
  "complaints",
  "unsubscribes",
  "revenue",
];

const BRIEF_ALIASES: Record<string, AnomalyMetric> = {
  open: "opens",
  click: "clicks",
  bounce: "bounces",
  complaint: "complaints",
  unsub: "unsubscribes",
  unsubs: "unsubscribes",
  unsubscribe: "unsubscribes",
};

/**
 * Map a dashboard anomaly's metric onto the brief endpoint's whitelist. Null
 * for metrics it cannot explain — callers withhold the action instead of
 * offering one that 422s.
 */
export function asBriefMetric(
  metric: string | null | undefined,
): AnomalyMetric | null {
  if (!metric) return null;
  const key = metric.trim().toLowerCase();
  if ((BRIEF_METRICS as readonly string[]).includes(key)) {
    return key as AnomalyMetric;
  }
  return BRIEF_ALIASES[key] ?? null;
}

/** Anomaly rows record the window they were detected over. */
export function briefWindowDays(rangeUsed: string | null | undefined): number {
  if (rangeUsed === "30d") return 30;
  if (rangeUsed === "90d") return 90;
  return 7;
}

const METRIC_NOUN: Record<AnomalyMetric, string> = {
  opens: "open",
  clicks: "click",
  bounces: "bounce",
  complaints: "complaint",
  unsubscribes: "unsubscribe",
  revenue: "revenue",
};

export function formatBriefValue(
  metric: AnomalyMetric,
  value: number,
  currency: string | null | undefined,
): string {
  if (metric !== "revenue") return value.toLocaleString();
  if (!currency) {
    return value === 0 ? "0 (no currency recorded)" : "unavailable";
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(value / 100);
  } catch {
    return "unavailable";
  }
}

/** "+42% vs previous 7 days"; no honest percentage exists over a zero base. */
export function formatBriefChange(
  current: number,
  previous: number,
  windowDays: number,
): string {
  const win = `previous ${windowDays} days`;
  if (previous === 0) {
    return current === 0
      ? "No activity in either window"
      : `No activity in the ${win} to compare against`;
  }
  const pct = (current / previous - 1) * 100;
  if (!Number.isFinite(pct)) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs ${win}`;
}

type BriefState =
  | { status: "loading" }
  | { status: "ready"; brief: AnomalyBriefResult }
  | { status: "unavailable" }
  | { status: "error"; message: string };

function progressCopy(seconds: number): string {
  if (seconds < 10) return "Asking the model to analyse the change…";
  if (seconds < 30) {
    return "Still working — comparing this window against the previous one…";
  }
  return "Almost there — long analyses can take up to 90 seconds.";
}

export function AnomalyBriefDialog({
  request,
  onClose,
}: {
  /** null = closed. */
  request: AnomalyBriefRequest | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<BriefState>({ status: "loading" });
  const [elapsed, setElapsed] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const seqRef = useRef(0);
  const metric = request?.metric ?? null;
  const windowDays = request?.windowDays ?? null;

  useEffect(() => {
    if (metric === null || windowDays === null) return;
    const seq = ++seqRef.current;
    setState({ status: "loading" });
    setElapsed(0);
    const tick = window.setInterval(
      () => setElapsed((s) => Math.min(s + 1, 90)),
      1000,
    );
    void (async () => {
      try {
        const outcome = await getAnomalyBrief({ metric, windowDays });
        if (seq !== seqRef.current) return;
        if (!outcome.ok) {
          setState({ status: "unavailable" });
        } else if (
          outcome.value.metric !== metric ||
          outcome.value.windowDays !== windowDays
        ) {
          setState({
            status: "error",
            message:
              "The explanation that came back was for a different metric or window, so it isn't shown. Try again before acting on this anomaly.",
          });
        } else {
          setState({ status: "ready", brief: outcome.value });
        }
      } catch (error) {
        if (seq !== seqRef.current) return;
        setState({
          status: "error",
          message: apiErrorMessage(
            error,
            "The explanation service could not complete the request.",
          ),
        });
      } finally {
        window.clearInterval(tick);
      }
    })();
    return () => {
      window.clearInterval(tick);
      // Invalidate the in-flight answer: a late response for a closed or
      // superseded request must never land.
      if (seq === seqRef.current) seqRef.current += 1;
    };
  }, [metric, windowDays, attempt]);

  const open = request !== null;
  const noun = metric ? METRIC_NOUN[metric] : "metric";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            Explain the {noun} anomaly
          </DialogTitle>
          <DialogDescription>
            Last {windowDays ?? 7} days compared with the {windowDays ?? 7} days
            before. AI requests can take up to 90 seconds; closing this dialog
            changes nothing.
          </DialogDescription>
        </DialogHeader>

        <div aria-busy={state.status === "loading" || undefined}>
          {state.status === "loading" ? (
            <p role="status" aria-live="polite" className="text-sm">
              {progressCopy(elapsed)}{" "}
              <span className="tabular-nums text-muted-foreground">
                ({elapsed}s)
              </span>
            </p>
          ) : null}

          {state.status === "unavailable" ? (
            <p role="alert" className="text-sm text-warning-emphasis">
              {AI_UNAVAILABLE_MESSAGE}
            </p>
          ) : null}

          {state.status === "error" ? (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          ) : null}

          {state.status === "ready" && metric ? (
            <BriefBody brief={state.brief} metric={metric} />
          ) : null}
        </div>

        <DialogFooter>
          {state.status === "error" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          ) : null}
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BriefBody({
  brief,
  metric,
}: {
  brief: AnomalyBriefResult;
  metric: AnomalyMetric;
}) {
  const currency = brief.revenueScope?.currency ?? null;
  const unit = metric === "revenue" ? "revenue" : `${METRIC_NOUN[metric]} events`;
  // Model-authored prose can echo subscriber emails, ids, links or pasted
  // credentials from the events it read; redact before display, as desktop does.
  const summary = safeBriefText(brief.summary, MAX_BRIEF_NARRATIVE_LENGTH);
  const probableCauses = safeBriefList(brief.probableCauses);
  const suggestedActions = safeBriefList(brief.suggestedActions);
  return (
    <div className="space-y-5 text-sm" aria-live="polite">
      <section aria-labelledby="anomaly-brief-summary" className="space-y-1">
        <h3 id="anomaly-brief-summary" className="font-semibold">
          Summary
        </h3>
        <p className="leading-relaxed">
          {summary ||
            "No narrative summary was returned. Review the evidence below before acting."}
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="anomaly-brief-causes" className="space-y-1">
          <h3 id="anomaly-brief-causes" className="font-semibold">
            Probable causes
          </h3>
          {probableCauses.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5">
              {probableCauses.map((cause, i) => (
                <li key={`${i}-${cause}`}>{cause}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              The model did not return probable causes for this window.
            </p>
          )}
        </section>
        <section aria-labelledby="anomaly-brief-actions" className="space-y-1">
          <h3 id="anomaly-brief-actions" className="font-semibold">
            Suggested actions
          </h3>
          {suggestedActions.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5">
              {suggestedActions.map((action, i) => (
                <li key={`${i}-${action}`}>{action}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              The model did not return suggested actions. Nothing has been
              changed.
            </p>
          )}
        </section>
      </div>

      <section
        aria-labelledby="anomaly-brief-evidence"
        className="space-y-3 rounded-md border bg-muted/20 p-3"
      >
        <h3 id="anomaly-brief-evidence" className="font-semibold">
          What the numbers say
        </h3>
        {brief.revenueScope ? (
          <p className="text-xs text-muted-foreground">
            {brief.revenueScope.currency === null
              ? "No monetary conversions were recorded in either window, so no currency was selected."
              : `Totals are scoped to ${brief.revenueScope.currency}${
                  brief.revenueScope.excludedCurrencyCount > 0
                    ? `; ${brief.revenueScope.excludedCurrencyCount.toLocaleString()} other ${
                        brief.revenueScope.excludedCurrencyCount === 1
                          ? "currency was"
                          : "currencies were"
                      } excluded.`
                    : "."
                }`}
          </p>
        ) : null}
        <dl className="grid gap-2 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">
              Last {brief.windowDays} days ({unit})
            </dt>
            <dd className="font-semibold tabular-nums">
              {formatBriefValue(metric, brief.currentTotal, currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Previous {brief.windowDays} days
            </dt>
            <dd className="font-semibold tabular-nums">
              {formatBriefValue(metric, brief.previousTotal, currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Change</dt>
            <dd className="font-semibold tabular-nums">
              {formatBriefChange(
                brief.currentTotal,
                brief.previousTotal,
                brief.windowDays,
              )}
            </dd>
          </div>
        </dl>
        {brief.daily.length >= 2 ? (
          <LineChart
            values={brief.daily.map((point) => point.value)}
            labels={brief.daily.map((point) => point.day)}
            height={120}
            ariaLabel={`Daily ${unit} over the last ${brief.windowDays} days`}
          />
        ) : null}
        {brief.topCampaigns.length > 0 ? (
          <div className="space-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">
              Top campaigns in this window
            </h4>
            <ul className="space-y-1">
              {brief.topCampaigns.map((campaign) => (
                <li
                  key={campaign.campaignId}
                  className="flex items-center justify-between gap-3"
                >
                  <Link
                    href={asRoute(`/app/campaigns/${campaign.campaignId}`)}
                    className="min-w-0 truncate text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {campaign.campaignName || "Untitled campaign"}
                  </Link>
                  <span className="shrink-0 tabular-nums">
                    {formatBriefValue(metric, campaign.value, currency)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No per-campaign breakdown was available for this window.
          </p>
        )}
      </section>

      <p role="note" className="text-xs text-muted-foreground">
        AI-generated from aggregate workspace statistics. Verify the numbers
        and the campaign context before acting.
      </p>
    </div>
  );
}
