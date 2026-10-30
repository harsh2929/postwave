/**
 * RFMProfileCard — per-subscriber RFM + predictive card for the
 * SubscriberDetailSlideover "Predictive" tab (SUB-126).
 *
 * Reuses the existing predictive infrastructure consumed by the Analytics
 * page's RFMSection (apps/api/internal/predictive):
 *
 *   GET /api/v1/predictive/profiles/{email} → {prediction, rfm}
 *
 * The current API does not attach currency provenance to monetary values.
 * This surface therefore fails closed: it renders currency-independent
 * recency, frequency, cadence, and churn signals, while hiding CLV,
 * monetary scores, composite RFM scores, and segments.
 *
 * Honesty notes (kept identical to RFMSection so the two surfaces agree):
 *   - 404 → "no predictive profile yet" empty state, not an error toast.
 *   - Low data sufficiency / low confidence shows ConfidenceNote("low").
 *   - Scores are heuristic ("heuristic-v1" server-side), never dressed as ML.
 */
import { type ReactElement, useEffect, useRef, useState } from "react";

import {
  type PredictiveProfileAnalytics,
  predictiveApi,
} from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";
import { ConfidenceNote, EstimateBadge } from "../common/Provenance";
import { PredictiveCurrencySafetyNotice } from "./PredictiveCurrencySafetyNotice";

interface Props {
  /** Subscriber email — the predictive profile is keyed by email. */
  email: string;
}

/**
 * Honest low-sample gate — mirrors RFMSection.isLowSufficiency so both
 * surfaces flag caution on exactly the same signals.
 */
function isLowSufficiency(
  dataSufficiency: string | undefined,
  confidence: number | undefined,
): boolean {
  const s = (dataSufficiency ?? "").toLowerCase();
  if (s.includes("low") || s.includes("insufficient")) return true;
  return typeof confidence === "number" && confidence > 0 && confidence < 0.4;
}

function scoreLabel(prefix: "R" | "F", value: unknown): string {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5
    ? `${prefix}${String(value)}`
    : "Unavailable";
}

function countLabel(value: unknown, noun: string): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return "count unavailable";
  }
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

function fractionLabel(value: unknown): string {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? `${(value * 100).toFixed(0)}%`
    : "Unavailable";
}

function nonNegativeNumberLabel(value: unknown, suffix: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "Unavailable";
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
}

function safeTimestampLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "Unavailable";
  return Number.isFinite(Date.parse(value)) ? fmtDate(value) : "Unavailable";
}

function StatRow({
  label,
  value,
  sub,
  estimate,
}: {
  label: string;
  value: string;
  sub?: string;
  /** True for predicted/projected fields (not observed history). */
  estimate?: boolean;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        padding: "5px 8px",
        background: "var(--pw-bg-elev-2)",
        borderRadius: 4,
      }}
    >
      <span
        className="muted"
        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
      >
        {label}
        {estimate ? <EstimateBadge /> : null}
      </span>
      <span style={{ textAlign: "right" }}>
        <span className="tabular" style={{ fontSize: 13 }}>
          {value}
        </span>
        {sub ? (
          <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
            {sub}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function RFMProfileCard({ email }: Props): ReactElement {
  const [profile, setProfile] = useState<PredictiveProfileAnalytics | null>(
    null,
  );
  const [state, setState] = useState<"loading" | "loaded" | "none" | "error">(
    "loading",
  );
  const [err, setErr] = useState<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);

  const load = async (): Promise<void> => {
    const e = email.trim().toLowerCase();
    if (!e) {
      setState("none");
      return;
    }
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setState("loading");
    setErr(null);
    const res = await predictiveApi.profile(e, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (res.error) {
      // 404 = no scored profile for this email (not a known subscriber with
      // order history, or scores haven't been computed yet) — an empty
      // state, not an error.
      if (res.error.status === 404) {
        setProfile(null);
        setState("none");
        return;
      }
      setErr(res.error.message);
      setState("error");
      return;
    }
    setProfile(res.data ?? null);
    setState("loaded");
  };

  useEffect(() => {
    setProfile(null);
    void load();
    return () => {
      requestControllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  if (state === "loading" && !profile) {
    return <div className="skel" style={{ height: 180 }} />;
  }

  if (state === "error" && !profile) {
    return (
      <div className="notice" role="alert" style={{ fontSize: 12 }}>
        <span>
          Couldn&apos;t load predictive profile{err ? `: ${err}` : "."}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => void load()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (state === "none" || !profile) {
    return (
      <div className="pw-chart-empty">
        No predictive profile for this subscriber yet — RFM and CLV scores only
        exist after a recompute has run over subscribers with order history. Run
        a recompute from the Segments page&apos;s &ldquo;RFM &amp;
        predictive&rdquo; section once order data has been ingested.
      </div>
    );
  }

  const { prediction, rfm } = profile;
  const low = isLowSufficiency(
    prediction.data_sufficiency,
    prediction.confidence,
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {state === "error" ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          <span>
            Couldn&apos;t refresh predictive profile{err ? `: ${err}` : "."}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      ) : null}
      <PredictiveCurrencySafetyNotice />

      {/* Currency-independent observed purchase signals. */}
      <div className="card" style={{ display: "grid", gap: 10 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "grid", gap: 4 }}>
            <strong style={{ fontSize: 13 }}>Observed purchase signals</strong>
            <span className="muted" style={{ fontSize: 11 }}>
              Currency-independent recency and order frequency
            </span>
          </div>
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <StatRow
            label="Recency"
            value={scoreLabel("R", rfm.recency_score)}
            sub={
              typeof rfm.recency_days === "number" &&
              Number.isSafeInteger(rfm.recency_days) &&
              rfm.recency_days >= 0
                ? `${rfm.recency_days.toLocaleString()} days since last order`
                : "recency unavailable"
            }
          />
          <StatRow
            label="Frequency"
            value={scoreLabel("F", rfm.frequency_score)}
            sub={countLabel(rfm.frequency, "order")}
          />
        </div>
        {rfm.calculated_at ? (
          <div className="muted" style={{ fontSize: 10 }}>
            RFM computed {fmtDate(rfm.calculated_at)}
          </div>
        ) : null}
      </div>

      {/* Currency-independent heuristic projections. */}
      <div className="card" style={{ display: "grid", gap: 8 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 13,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          Cadence &amp; churn projections
          <EstimateBadge />
        </div>
        <div style={{ display: "grid", gap: 4 }}>
          <StatRow
            label="Churn risk"
            value={fractionLabel(prediction.churn_risk)}
            estimate
          />
          <StatRow
            label="Predicted orders / yr"
            value={nonNegativeNumberLabel(prediction.predicted_order_count, "")}
            estimate
          />
          <StatRow
            label="Average order cadence"
            value={nonNegativeNumberLabel(
              prediction.average_days_between_orders,
              " days",
            )}
            estimate
          />
          <StatRow
            label="Expected next order"
            value={safeTimestampLabel(prediction.expected_next_order_at)}
            estimate
          />
          <StatRow
            label="Confidence"
            value={fractionLabel(prediction.confidence)}
            sub={
              typeof prediction.data_sufficiency === "string"
                ? prediction.data_sufficiency.slice(0, 80)
                : ""
            }
          />
        </div>
        {low ? <ConfidenceNote level="low" /> : null}
      </div>
    </div>
  );
}
