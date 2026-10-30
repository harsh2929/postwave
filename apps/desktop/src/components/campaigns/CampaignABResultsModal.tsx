/**
 * Campaign A/B results modal.
 *
 * Keeps statistical presentation and method-tab state outside the campaign
 * list controller while preserving the API-owned result identity.
 */

import { type ReactElement, useState } from "react";

import { InlineHelp } from "../InlineHelp";
import { ExternalLink } from "../ExternalLink";
import { ChoiceGroup } from "../ChoiceGroup";
import { Modal, ModalFooter } from "../Modal";
import { ResultsCard } from "../abtest/ResultsCard";
import { SignificanceBadge } from "../abtest/SignificanceBadge";
import { WinnerBanner } from "../abtest/WinnerBanner";
import { MultiLineChart } from "../charts/MultiLineChart";
import type {
  ABFrequentistOutcome,
  ABMetric,
  ABResultsResponse,
  ABWeightHistorySeries,
  Campaign,
} from "../../lib/api-client";

export function winnerFrequentistOutcome(
  results: ABResultsResponse,
): ABFrequentistOutcome | undefined {
  const winner = results.winner;
  if (!winner || winner.variant_index < 0) return undefined;
  const label = results.variants.find(
    (variant) => variant.variant_index === winner.variant_index,
  )?.variant_label;
  return results.frequentist[`control_vs_${label || winner.variant_index}`];
}

export function CampaignABResultsModal({
  campaign,
  metric,
  onMetricChange,
  data,
  weightHistory,
  loading,
  error,
  onClose,
}: {
  campaign: Campaign | null;
  metric: ABMetric;
  onMetricChange: (metric: ABMetric) => void;
  data: ABResultsResponse | null;
  weightHistory: ABWeightHistorySeries[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
}): ReactElement {
  const [methodTab, setMethodTab] = useState<"frequentist" | "bayesian">(
    "bayesian",
  );

  return (
    <Modal
      open={campaign != null}
      onClose={() => onClose()}
      title={`A/B Results — ${campaign?.name ?? ""}`}
      description="Per-variant scores with significance + Bayesian P(B>A)."
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <select
          className="input"
          value={metric}
          onChange={(e) => onMetricChange(e.target.value as ABMetric)}
          style={{ maxWidth: 180 }}
        >
          <option value="open_rate">Open rate</option>
          <option value="click_rate">Click rate</option>
          <option value="reply_rate">Reply rate</option>
        </select>
        <ChoiceGroup
          legend="Statistical method"
          value={methodTab}
          onChange={setMethodTab}
          className="tabs"
          optionClassName="tab"
          options={(["bayesian", "frequentist"] as const).map((method) => ({
            value: method,
            label: method === "bayesian" ? "Bayesian" : "Frequentist",
            className: methodTab === method ? "is-active" : undefined,
          }))}
        />
        <span className="spacer" />
        <ExternalLink
          href="https://docs.postwave.dev/ab-tests/methodology"
          className="btn btn-sm"
        >
          Why these stats?
        </ExternalLink>
      </div>

      {/* G4 follow-up: bandit allocation-drift — how the bandit shifted
            weight toward the better arm over the send. */}
      {weightHistory.some((s) => s.points.length >= 2) ? (
        <div style={{ marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            Allocation drift — bandit weight per variant over time
          </div>
          <MultiLineChart
            series={weightHistory.map((s) => ({
              label: s.label || s.variant_id.slice(0, 6),
              values: s.points.map((p) => ({
                date: p.at,
                count: Math.round(p.weight),
              })),
            }))}
            formatDate={(d) =>
              d.toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
              })
            }
            title="A/B allocation drift"
            valueLabel="Allocation weight (%)"
            provenance={{
              source: "Moosewave campaign A/B weight-history API",
              asOf: null,
              scope: `Campaign ${campaign?.id ?? "selected"} · all recorded bandit adjustments`,
              note: "Weights are rounded to whole percentage points for this visual and export.",
            }}
            exportFileName="campaign-ab-allocation-drift.csv"
            exportPrivacy="confidential"
          />
        </div>
      ) : null}

      {loading ? <div className="muted">Loading…</div> : null}
      {error ? (
        <div className="notice">Couldn&apos;t load results: {error}</div>
      ) : null}

      {data ? (
        <>
          {data.winner ? (
            <WinnerBanner
              variantIndex={data.winner.variant_index}
              variantLabel={
                data.variants[data.winner.variant_index]?.variant_label
              }
              liftPercent={
                data.winner.method === "frequentist"
                  ? winnerFrequentistOutcome(data)?.lift_percent
                  : undefined
              }
              method={data.winner.method}
              confidence={data.winner.confidence}
            />
          ) : null}

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              marginBottom: 12,
            }}
          >
            {data.variants.map((v) => (
              <ResultsCard
                key={v.id}
                variant={v}
                metricLabel={
                  data.metric === "open_rate"
                    ? "Open rate"
                    : data.metric === "click_rate"
                      ? "Click rate"
                      : "Reply rate"
                }
                isWinner={data.winner?.variant_index === v.variant_index}
              />
            ))}
          </div>

          <div style={{ marginBottom: 8 }}>
            <strong>Pairwise vs control</strong>
            <InlineHelp text="Each variant is compared head-to-head with the control. The significance badge marks comparisons where the lift is unlikely to be noise (p<0.05 / P(B>A)>95%)." />
            {data.bonferroni.applied_to_frequentist ? (
              <div className="muted" style={{ fontSize: 12 }}>
                Bonferroni: {data.bonferroni.num_comparisons} comparisons,
                corrected α = {data.bonferroni.corrected_alpha.toFixed(4)}
              </div>
            ) : null}
          </div>

          {methodTab === "frequentist" ? (
            <div style={{ display: "grid", gap: 6 }}>
              {Object.entries(data.frequentist).map(([key, f]) => (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "6px 0",
                    borderTop: "1px solid var(--pw-border)",
                  }}
                >
                  <span>{key}</span>
                  <span className="tabular">
                    z={f.z_score.toFixed(2)} · p={f.p_value.toFixed(4)} · lift=
                    {f.lift_percent.toFixed(1)}%
                  </span>
                  <SignificanceBadge
                    significant={
                      data.bonferroni.applied_to_frequentist
                        ? f.significant_after_correction
                        : f.significant_at_95
                    }
                    label={
                      data.bonferroni.applied_to_frequentist
                        ? "Bonferroni"
                        : "95%"
                    }
                    title={`raw p=${f.p_value.toFixed(4)}, corrected α=${data.bonferroni.corrected_alpha.toFixed(4)}`}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {Object.entries(data.bayesian).map(([key, b]) => (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "6px 0",
                    borderTop: "1px solid var(--pw-border)",
                  }}
                >
                  <span>{key}</span>
                  <span className="tabular">
                    P(B&gt;A)={(b.prob_b_better * 100).toFixed(1)}% · 95% CI [
                    {b.credible_interval_95[0].toFixed(3)},{" "}
                    {b.credible_interval_95[1].toFixed(3)}]
                  </span>
                  <SignificanceBadge
                    significant={b.prob_b_better >= 0.95}
                    label="P(B>A)>95%"
                    title={`expected lift ${(b.expected_lift * 100).toFixed(1)}%`}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}

      <ModalFooter>
        <button type="button" className="btn" onClick={() => onClose()}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}
