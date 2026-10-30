import type { ReactElement } from "react";

import type {
  SubscriberCurrencyRevenue,
  SubscriberEngagementResult,
} from "../../lib/api-client";
import { Notice } from "../Notice";
import { fmtCents } from "../segments/rfm-helpers";

interface ContactPerformanceCardProps {
  performance: SubscriberEngagementResult;
}

function countLabel(value: unknown): string {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value.toLocaleString()
    : "Unavailable";
}

function revenueLabel(item: SubscriberCurrencyRevenue): string {
  if (item.revenue_cents_saturated || !Number.isSafeInteger(item.revenue_cents)) {
    return "Exceeds display range";
  }
  return fmtCents(item.revenue_cents, item.currency);
}

function RevenueBreakdown({
  items,
}: {
  items: SubscriberCurrencyRevenue[];
}): ReactElement | null {
  if (items.length < 2) return null;
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", fontSize: 11 }}>
        Revenue by currency · {items.length.toLocaleString()} denominations
      </summary>
      <ul
        aria-label="Attributed revenue by currency"
        style={{
          display: "grid",
          gap: 4,
          listStyle: "none",
          margin: "8px 0 0",
          maxHeight: 220,
          overflow: "auto",
          padding: 0,
        }}
      >
        {items.map((item) => (
          <li
            key={item.currency}
            className="stat-cell"
            style={{
              alignItems: "baseline",
              display: "flex",
              gap: 8,
              justifyContent: "space-between",
            }}
          >
            <span>
              <strong>{item.currency}</strong>{" "}
              <span className="muted">
                · {countLabel(item.conversions)} conversion
                {item.conversions === 1 ? "" : "s"}
              </span>
            </span>
            <span className="tabular">{revenueLabel(item)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function RevenueMetric({
  performance,
}: ContactPerformanceCardProps): ReactElement {
  const counts = performance.counts;
  const breakdown = Array.isArray(counts.revenue_by_currency)
    ? counts.revenue_by_currency
    : [];
  const primary = breakdown[0];
  const legacyUnlabelled =
    breakdown.length === 0 &&
    counts.revenue_by_currency === undefined &&
    typeof counts.revenue_cents === "number" &&
    counts.revenue_cents !== 0;
  const value = primary
    ? revenueLabel(primary)
    : legacyUnlabelled
      ? "Currency unavailable"
      : "No attributed revenue";
  return (
    <div className="stat-cell">
      <div
        className="muted"
        style={{
          alignItems: "center",
          display: "flex",
          flexWrap: "wrap",
          fontSize: 11,
          gap: 4,
        }}
      >
        {counts.mixed_currency ? "Leading revenue" : "Revenue"}
        {primary ? <span className="badge">{primary.currency}</span> : null}
        {counts.mixed_currency ? (
          <span className="badge warning">Mixed</span>
        ) : null}
      </div>
      <div className="tabular" style={{ fontSize: 16, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}

export function ContactPerformanceCard({
  performance,
}: ContactPerformanceCardProps): ReactElement {
  const counts = performance.counts;
  const breakdown = Array.isArray(counts.revenue_by_currency)
    ? counts.revenue_by_currency
    : [];
  const unclassified = counts.unclassified_monetary_conversions;
  const legacyUnlabelled =
    counts.revenue_by_currency === undefined &&
    typeof counts.revenue_cents === "number" &&
    counts.revenue_cents !== 0;
  const metrics = [
    ["Sends", counts.sends],
    ["Opens", counts.opens],
    ["Clicks", counts.clicks],
    ["Replies", counts.replies],
  ] as const;

  return (
    <div style={{ marginTop: 14 }}>
      <div className="label">Contact performance · 90 days</div>
      <p className="muted" style={{ fontSize: 11, margin: "2px 0 0" }}>
        Successful sends, recipient engagement, and safely denominated
        attributed revenue over the trailing 90 days.
      </p>
      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))",
          marginTop: 6,
        }}
      >
        {metrics.map(([label, value]) => (
          <div key={label} className="stat-cell">
            <div className="muted" style={{ fontSize: 11 }}>
              {label}
            </div>
            <div className="tabular" style={{ fontSize: 16, fontWeight: 600 }}>
              {countLabel(value)}
            </div>
          </div>
        ))}
        <RevenueMetric performance={performance} />
      </div>

      <RevenueBreakdown items={breakdown} />

      {legacyUnlabelled ? (
        <Notice tone="warning" title="Revenue currency unavailable">
          This server returned an amount without a denomination. The amount is
          hidden rather than being labelled as an assumed currency.
        </Notice>
      ) : null}
      {typeof unclassified === "number" && unclassified > 0 ? (
        <Notice tone="warning" title="Some monetary conversions were excluded">
          {countLabel(unclassified)} amount-bearing conversion
          {unclassified === 1 ? " was" : "s were"} missing a recognized
          currency and are not included in revenue totals.
        </Notice>
      ) : null}
      {breakdown.some(
        (item) =>
          item.revenue_cents_saturated ||
          !Number.isSafeInteger(item.revenue_cents),
      ) ? (
        <Notice tone="warning" title="One or more totals exceed display range">
          The exact amount cannot be represented safely by this desktop client.
          No rounded total is shown.
        </Notice>
      ) : null}

      {performance.opens_30d != null || performance.clicks_30d != null ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          Last 30 days: {countLabel(performance.opens_30d ?? 0)} open
          {performance.opens_30d === 1 ? "" : "s"} ·{" "}
          {countLabel(performance.clicks_30d ?? 0)} click
          {performance.clicks_30d === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  );
}
