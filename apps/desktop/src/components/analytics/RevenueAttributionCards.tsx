import type { ReactElement, ReactNode } from "react";

import type {
  CampaignAttributionResponse,
  RevenueAttributionItem,
  RevenueTimeseriesResponse,
} from "../../lib/api-client";
import { LineChart } from "../charts/LineChart";
import { ComputedFrom } from "../common/Provenance";
import { InlineHelp } from "../InlineHelp";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import {
  campaignFilterOptions,
  currencyDisclosure,
  fmtMoneyCents,
  isRollupRow,
  revenuePerSendText,
  revenueTickStride,
  revenueTimeseriesHasActivity,
  revenueTimeseriesPoints,
} from "./revenue-attribution";

interface RevenueAttributionCardProps {
  attribution: CampaignAttributionResponse | null;
  days: number;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}

interface AttributionTotalsProps {
  attribution: CampaignAttributionResponse;
  currency?: string;
}

function AttributionTotals({
  attribution,
  currency,
}: AttributionTotalsProps): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: 24,
        flexWrap: "wrap",
        alignItems: "baseline",
        paddingBottom: 8,
        borderBottom: "1px solid var(--pw-border)",
        marginBottom: 8,
      }}
    >
      <div>
        <div className="muted" style={{ fontSize: 10 }}>
          Workspace conversion revenue (net)
          <InlineHelp text="Net conversion revenue in the response's dominant currency, including campaign-attributed and unattributed conversions. Refunds can make this value negative. This is not the campaign-attributed subtotal." />
        </div>
        <div
          className="tabular"
          style={{ fontSize: 18, color: "var(--pw-fg)" }}
        >
          {fmtMoneyCents(attribution.total_revenue_cents, currency)}
        </div>
      </div>
      <div>
        <div className="muted" style={{ fontSize: 10 }}>
          Unattributed
          <InlineHelp text="Revenue from conversions that couldn't be tied to any campaign send (e.g. direct purchases). Included so the table's campaign totals can't overstate email's share." />
        </div>
        <div
          className="tabular"
          style={{ fontSize: 18, color: "var(--pw-fg-muted)" }}
        >
          {fmtMoneyCents(attribution.unattributed_cents, currency)}
          <span className="muted" style={{ fontSize: 11 }}>
            {" "}
            · {attribution.unattributed_conversions.toLocaleString()} conversion
            {attribution.unattributed_conversions === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}

interface AttributionTableProps {
  currency?: string;
  items: RevenueAttributionItem[];
}

function AttributionTable({
  currency,
  items,
}: AttributionTableProps): ReactElement {
  const columns: readonly DataTableColumn<RevenueAttributionItem>[] = [
    {
      id: "campaign",
      header: "Campaign",
      width: "320px",
      cell: (item) => {
        const rollup = isRollupRow(item);
        return (
          <span
            className="pw-table-truncate"
            style={{
              color: rollup ? "var(--pw-fg-muted)" : "var(--pw-fg)",
              fontStyle: rollup ? "italic" : undefined,
            }}
            title={
              rollup
                ? "Campaigns beyond the top 50, rolled into one row"
                : item.campaign_name
            }
          >
            {item.campaign_name}
          </span>
        );
      },
    },
    {
      id: "revenue",
      header: "Revenue",
      align: "end",
      cell: (item) => (
        <AttributionNumber item={item}>
          {fmtMoneyCents(item.revenue_cents, currency)}
        </AttributionNumber>
      ),
    },
    {
      id: "conversions",
      header: "Conversions",
      align: "end",
      cell: (item) => (
        <AttributionNumber item={item}>
          {item.conversions.toLocaleString()}
        </AttributionNumber>
      ),
    },
    {
      id: "emails-sent",
      header: "Emails sent",
      align: "end",
      cell: (item) => (
        <AttributionNumber item={item}>
          {item.emails_sent.toLocaleString()}
        </AttributionNumber>
      ),
    },
    {
      id: "revenue-per-send",
      header: "Rev / send",
      align: "end",
      cell: (item) => (
        <AttributionNumber
          item={item}
          title={
            item.revenue_per_send_cents == null
              ? "Not computed by the backend for rollup or zero-send rows"
              : undefined
          }
        >
          {revenuePerSendText(item, currency)}
        </AttributionNumber>
      ),
    },
  ];
  return (
    <DataTable
      caption="Revenue by campaign"
      description="Last-touch attribution; campaigns beyond the top 50 are combined in the labelled rollup row."
      columns={columns}
      rows={items}
      getRowKey={(item) =>
        isRollupRow(item)
          ? "__rollup"
          : item.campaign_id || `campaign-${item.campaign_name}`
      }
      density="compact"
    />
  );
}

function AttributionNumber({
  item,
  children,
  title,
}: {
  item: RevenueAttributionItem;
  children: ReactNode;
  title?: string | undefined;
}): ReactElement {
  return (
    <span
      className="tabular"
      style={{
        color: isRollupRow(item) ? "var(--pw-fg-muted)" : "var(--pw-fg)",
      }}
      title={title}
    >
      {children}
    </span>
  );
}

export function RevenueAttributionCard({
  attribution,
  days,
  error,
  loading,
  onRetry,
}: RevenueAttributionCardProps): ReactElement {
  const items = attribution?.items ?? [];
  const currency = attribution?.currency || undefined;
  const disclosure = attribution ? currencyDisclosure(attribution) : null;
  const listedCampaigns = items.filter((item) => !isRollupRow(item)).length;
  const totalCampaigns = attribution?.total_campaigns;
  const showCampaignProvenance =
    typeof totalCampaigns === "number" && totalCampaigns > listedCampaigns;
  const hasAnyRevenue =
    attribution != null &&
    (attribution.total_revenue_cents !== 0 ||
      attribution.unattributed_cents !== 0 ||
      attribution.unattributed_conversions > 0 ||
      attribution.currencies.some(
        (entry) => entry.revenue_cents !== 0 || entry.conversions > 0,
      ) ||
      items.some((item) => item.revenue_cents !== 0 || item.conversions > 0));

  return (
    <div className="card pw-chart-card" style={{ marginTop: 12 }}>
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Conversion revenue and campaign attribution
          <InlineHelp text="Workspace net conversion revenue is shown separately from the campaign-attributed rows. The top 50 campaigns are listed individually; the rest roll into '(other campaigns)'. Revenue that couldn't be matched to a campaign is reported as unattributed, and refunds remain visible as negative amounts." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          last {attribution?.days ?? days} days
          {showCampaignProvenance ? (
            <>
              {" · "}
              <ComputedFrom
                n={listedCampaigns}
                m={totalCampaigns}
                unit="campaigns"
              />
            </>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load revenue attribution: {error}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="pw-chart-empty">Loading revenue attribution…</div>
      ) : !hasAnyRevenue ? (
        <div className="pw-chart-empty">
          No monetary conversion activity was recorded in the last {days} days —
          this section fills in once conversion amounts or refunds are tracked.
        </div>
      ) : attribution ? (
        <>
          <AttributionTotals attribution={attribution} currency={currency} />
          {disclosure?.label ? (
            <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
              {disclosure.label}
            </div>
          ) : null}
          {items.length > 0 ? (
            <AttributionTable items={items} currency={currency} />
          ) : (
            <div className="pw-chart-empty">
              Conversions were recorded but none could be attributed to a
              campaign in this window.
            </div>
          )}
        </>
      ) : null}

      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        This report attributes revenue to campaigns only; it does not offer
        per-sequence attribution.
      </div>
    </div>
  );
}

interface RevenueTimeseriesCardProps {
  attribution: CampaignAttributionResponse | null;
  campaignFilter: string;
  days: number;
  error: string | null;
  loading: boolean;
  onCampaignFilterChange: (campaignId: string) => void;
  onRetry: () => void;
  timeseries: RevenueTimeseriesResponse | null;
}

export function RevenueTimeseriesCard({
  attribution,
  campaignFilter,
  days,
  error,
  loading,
  onCampaignFilterChange,
  onRetry,
  timeseries,
}: RevenueTimeseriesCardProps): ReactElement {
  const filterOptions = campaignFilterOptions(attribution?.items);
  const points = revenueTimeseriesPoints(timeseries?.points);
  const hasActivity = revenueTimeseriesHasActivity(timeseries?.points);
  const currency = timeseries?.currency || attribution?.currency || undefined;

  return (
    <div className="card pw-chart-card" style={{ marginTop: 12 }}>
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Net conversion revenue over time
          <InlineHelp text="Daily net conversion revenue (zero-filled — days without conversions plot as 0). Refunds plot below zero and offsetting days remain visible even when the window net is zero. Filter to a campaign to see its contribution." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {currency ? `amounts in ${currency} · ` : ""}last{" "}
          {timeseries?.days ?? days} days
        </div>
        {filterOptions.length > 0 ? (
          <select
            aria-label="Filter revenue timeseries by campaign"
            value={campaignFilter}
            onChange={(event) => onCampaignFilterChange(event.target.value)}
            style={{ fontSize: 12, maxWidth: 220 }}
          >
            <option value="">All campaigns</option>
            {filterOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {error ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load the revenue timeseries: {error}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="pw-chart-empty">Loading revenue timeseries…</div>
      ) : points.length === 0 || !hasActivity ? (
        <div className="pw-chart-empty">
          {campaignFilter
            ? "No attributed revenue for this campaign in the window."
            : `No attributed revenue in the last ${days} days.`}
        </div>
      ) : (
        <LineChart
          data={points}
          height={200}
          xTickStride={revenueTickStride(timeseries?.days ?? days)}
          title="Net conversion revenue over time"
          valueLabel={`Net revenue${currency ? ` (${currency})` : ""}`}
          formatValue={(value) =>
            fmtMoneyCents(Math.round(value * 100), currency)
          }
          provenance={{
            source: "Moosewave conversion-attribution timeseries API",
            asOf: null,
            scope: `${campaignFilter ? `Campaign ${campaignFilter}` : "All campaigns"} · last ${timeseries?.days ?? days} days`,
            note: "Days without conversions are server-zero-filled; chart values use major currency units.",
          }}
          exportFileName="net-conversion-revenue-over-time.csv"
          exportPrivacy="confidential"
        />
      )}
    </div>
  );
}
