/**
 * UsageSection — Settings "Usage" section wiring #54 (API-usage
 * dashboard: /api-usage/summary, /keys, /timeseries) and #55 (cost
 * aggregate view: /costs?by=, plus the ledger drilldown:
 * /costs/ledger, cursor-paged).
 *
 * Honest-UI notes:
 *   - every load failure renders the error + a Retry button; nothing
 *     is fabricated while a fetch is down.
 *   - cost arrives as cents (snake_case on /api-usage, camelCase on
 *     /costs — see WIRING-WRAPPERS.md #55) and is always rendered as
 *     dollars via fmtCentsAsDollars.
 *   - sends and cost get separate charts: one y-axis per unit.
 */

import { type ReactElement, useCallback, useEffect, useState } from "react";

import {
  type APIUsageKeyRow,
  type APIUsageSummary,
  type CostAggregateRow,
  type CostLedgerEntry,
  apiUsageApi,
  costsApi,
} from "../../lib/api-client";
import { LineChart } from "../charts/LineChart";
import { SettingsSectionHeader } from "./SettingsNav";
import {
  COST_GROUP_BYS,
  type CostGroupBy,
  type UsagePoint,
  aggregateRowLabel,
  aggregateTotals,
  costLinePoints,
  fmtCentsAsDollars,
  fmtCount,
  mergeLedgerRows,
  sendsLinePoints,
  sinceParam,
  sortAggregateRows,
  sortKeyRows,
  summaryStats,
} from "./usage-helpers";

const WINDOWS = [7, 30, 90];

export function UsageSection(): ReactElement {
  const [days, setDays] = useState<number>(30);
  const [summary, setSummary] = useState<APIUsageSummary | null>(null);
  const [keys, setKeys] = useState<APIUsageKeyRow[] | null>(null);
  const [points, setPoints] = useState<UsagePoint[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const [sRes, kRes, tRes] = await Promise.all([
      apiUsageApi.summary(days),
      apiUsageApi.keys(days),
      apiUsageApi.timeseries(days),
    ]);
    const firstErr = sRes.error ?? kRes.error ?? tRes.error;
    if (firstErr) {
      setErr(firstErr.message);
      setSummary(null);
      setKeys(null);
      setPoints(null);
      setLoading(false);
      return;
    }
    setSummary(sRes.data ?? null);
    setKeys(kRes.data ? sortKeyRows(kRes.data.keys ?? []) : []);
    setPoints(tRes.data?.points ?? []);
    setLoading(false);
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Usage"
        description="API sends, metered cost, and active keys for this workspace. Cost figures come from the metering ledger."
        meta={
          <div className="chips" role="group" aria-label="Usage window">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                className={`chip${days === w ? " is-active" : ""}`}
                aria-pressed={days === w}
                onClick={() => setDays(w)}
              >
                {w}d
              </button>
            ))}
          </div>
        }
      />
      <div className="settings-section-body">
        {err ? (
          <div className="notice">
            <span>Couldn&apos;t load usage: {err}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <>
            <div className="skel-row" />
            <div className="skel-row" />
            <div className="skel-row" />
          </>
        ) : (
          <>
            {summary ? (
              <div className="stat-grid" style={{ marginBottom: 16 }}>
                {summaryStats(summary).map((s) => (
                  <div key={s.key} className="stat-card">
                    <div className="stat-label">{s.label}</div>
                    <div className="stat-value">{s.value}</div>
                    {s.hint ? (
                      <div className="muted" style={{ fontSize: 11 }}>
                        {s.hint}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {points && points.length > 0 ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                  gap: 16,
                  marginBottom: 16,
                }}
              >
                <div>
                  <div
                    className="muted"
                    style={{ fontSize: 12, marginBottom: 4 }}
                  >
                    Sends per day
                  </div>
                  <LineChart
                    data={sendsLinePoints(points)}
                    height={160}
                    title="API sends per day"
                    valueLabel="Sends"
                    provenance={{
                      source: "Moosewave API-usage timeseries endpoint",
                      asOf: null,
                      scope: `Current workspace · last ${days} days`,
                    }}
                    exportFileName={`api-sends-${days}d.csv`}
                    exportPrivacy="confidential"
                  />
                </div>
                <div>
                  <div
                    className="muted"
                    style={{ fontSize: 12, marginBottom: 4 }}
                  >
                    Cost per day ($)
                  </div>
                  <LineChart
                    data={costLinePoints(points)}
                    height={160}
                    title="Metered cost per day"
                    valueLabel="Cost (USD)"
                    formatValue={(value) =>
                      value.toLocaleString(undefined, {
                        style: "currency",
                        currency: "USD",
                      })
                    }
                    provenance={{
                      source: "Moosewave metering-ledger timeseries endpoint",
                      asOf: null,
                      scope: `Current workspace · last ${days} days`,
                      note: "Source values are cents; the chart and export use US dollars.",
                    }}
                    exportFileName={`metered-cost-usd-${days}d.csv`}
                    exportPrivacy="confidential"
                  />
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
                No usage recorded in the last {days} days.
              </div>
            )}

            <PerKeyTable keys={keys ?? []} />

            <CostAggregateTable days={days} />

            <CostLedgerDrilldown days={days} />
          </>
        )}
      </div>
    </div>
  );
}

function PerKeyTable({ keys }: { keys: APIUsageKeyRow[] }): ReactElement {
  if (keys.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        No per-key usage in this window.
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        Usage by API key
      </div>
      <div
        className="muted"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,2fr) 1fr 1fr 1fr",
          gap: 8,
          fontSize: 11,
          padding: "4px 0",
          borderBottom: "1px solid var(--pw-border-soft)",
        }}
      >
        <span>Key</span>
        <span>Actor</span>
        <span style={{ textAlign: "right" }}>Sends</span>
        <span style={{ textAlign: "right" }}>Cost</span>
      </div>
      {keys.map((k) => (
        <div
          key={k.id}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,2fr) 1fr 1fr 1fr",
            gap: 8,
            fontSize: 12,
            padding: "6px 0",
            borderBottom: "1px solid var(--pw-border-soft)",
            alignItems: "center",
          }}
        >
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {k.label || "(unlabeled)"}{" "}
            <span className="mono muted" style={{ fontSize: 11 }}>
              {k.prefix}…
            </span>
          </span>
          <span className="muted">{k.actor_type}</span>
          <span className="tabular" style={{ textAlign: "right" }}>
            {fmtCount(k.sends)}
          </span>
          <span className="tabular" style={{ textAlign: "right" }}>
            {fmtCentsAsDollars(k.cost_cents)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Cost aggregate view (#55) — grouped totals over the same window via
 * GET /costs?since=&by=. The group-by select switches between the
 * dimensions the endpoint accepts (api_key_id | kind | day); cents
 * always render as dollars like the rest of the section.
 * NOTE: /costs/* serializes camelCase (apiKeyId, kind, day, cents).
 */
function CostAggregateTable({ days }: { days: number }): ReactElement {
  const [by, setBy] = useState<CostGroupBy>("kind");
  const [rows, setRows] = useState<CostAggregateRow[] | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const res = await costsApi.aggregate({ since: sinceParam(days), by: [by] });
    setLoading(false);
    if (res.error) {
      setErr(res.error.message);
      setRows(null);
      return;
    }
    setRows(sortAggregateRows(res.data?.rows ?? [], by));
  }, [days, by]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = aggregateTotals(rows ?? []);

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>Cost totals</span>
        <span className="muted" style={{ fontSize: 12 }}>
          grouped, last {days} days
        </span>
        <span className="spacer" />
        <label
          className="muted"
          htmlFor="usage-cost-groupby"
          style={{ fontSize: 12 }}
        >
          Group by
        </label>
        <select
          id="usage-cost-groupby"
          className="input"
          style={{ width: "auto", fontSize: 12 }}
          value={by}
          onChange={(e) => setBy(e.target.value as CostGroupBy)}
        >
          {COST_GROUP_BYS.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
            </option>
          ))}
        </select>
      </div>
      {err ? (
        <div className="notice">
          <span>Couldn&apos;t load cost totals: {err}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void load()}
            disabled={loading}
          >
            Retry
          </button>
        </div>
      ) : rows === null ? (
        <div className="skel-row" />
      ) : rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No metered cost in this window.
        </div>
      ) : (
        <>
          <div
            className="muted"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,2fr) 0.8fr 0.7fr 0.8fr",
              gap: 8,
              fontSize: 11,
              padding: "4px 0",
              borderBottom: "1px solid var(--pw-border-soft)",
            }}
          >
            <span>{COST_GROUP_BYS.find((g) => g.key === by)?.label}</span>
            <span style={{ textAlign: "right" }}>Entries</span>
            <span style={{ textAlign: "right" }}>Qty</span>
            <span style={{ textAlign: "right" }}>Cost</span>
          </div>
          {rows.map((r, idx) => {
            const label = aggregateRowLabel(r, by);
            return (
              <div
                // aggregateRowLabel collapses null/blank buckets to a shared
                // placeholder ("(no key)" / "(unknown)"), so label alone is not
                // unique — suffix the row index to guarantee a distinct key.
                key={`${label}:${idx}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0,2fr) 0.8fr 0.7fr 0.8fr",
                  gap: 8,
                  fontSize: 12,
                  padding: "5px 0",
                  borderBottom: "1px solid var(--pw-border-soft)",
                }}
              >
                <span
                  className={
                    by === "kind" || by === "api_key_id" ? "mono" : "tabular"
                  }
                  style={{
                    fontSize: 11,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </span>
                <span className="tabular" style={{ textAlign: "right" }}>
                  {fmtCount(r.count)}
                </span>
                <span className="tabular" style={{ textAlign: "right" }}>
                  {fmtCount(r.quantity)}
                </span>
                <span className="tabular" style={{ textAlign: "right" }}>
                  {fmtCentsAsDollars(r.cents)}
                </span>
              </div>
            );
          })}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,2fr) 0.8fr 0.7fr 0.8fr",
              gap: 8,
              fontSize: 12,
              fontWeight: 600,
              padding: "5px 0",
            }}
          >
            <span>Total</span>
            <span className="tabular" style={{ textAlign: "right" }}>
              {fmtCount(totals.count)}
            </span>
            <span className="tabular" style={{ textAlign: "right" }}>
              {fmtCount(totals.quantity)}
            </span>
            <span className="tabular" style={{ textAlign: "right" }}>
              {fmtCentsAsDollars(totals.cents)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Cost-ledger drilldown (#55) — lazy: nothing is fetched until the
 * operator opens it. Keyset pagination via nextCursor ("Load more").
 * NOTE: /costs/* serializes camelCase (apiKeyId, nextCursor, at).
 */
function CostLedgerDrilldown({ days }: { days: number }): ReactElement {
  const [open, setOpen] = useState<boolean>(false);
  const [rows, setRows] = useState<CostLedgerEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState<boolean>(false);

  // Window change invalidates whatever pages we accumulated.
  useEffect(() => {
    setRows([]);
    setCursor(undefined);
    setHasMore(false);
    setLoadedOnce(false);
    setErr(null);
  }, [days]);

  const loadPage = useCallback(
    async (after?: string): Promise<void> => {
      setLoading(true);
      setErr(null);
      const res = await costsApi.ledger({
        since: sinceParam(days),
        cursor: after,
        limit: 50,
      });
      setLoading(false);
      if (res.error) {
        setErr(res.error.message);
        return;
      }
      const page = res.data?.rows ?? [];
      setRows((prev) => (after ? mergeLedgerRows(prev, page) : page));
      setCursor(res.data?.nextCursor);
      setHasMore(Boolean(res.data?.nextCursor));
      setLoadedOnce(true);
    },
    [days],
  );

  useEffect(() => {
    if (open && !loadedOnce && !loading) void loadPage();
  }, [open, loadedOnce, loading, loadPage]);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
        Cost ledger
        <span
          className="muted"
          style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}
        >
          itemized metering entries, last {days} days
        </span>
      </summary>
      <div style={{ marginTop: 8 }}>
        {err ? (
          <div className="notice">
            <span>Couldn&apos;t load ledger: {err}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() =>
                void loadPage(rows.length > 0 ? cursor : undefined)
              }
              disabled={loading}
            >
              Retry
            </button>
          </div>
        ) : null}
        {loading && rows.length === 0 ? (
          <>
            <div className="skel-row" />
            <div className="skel-row" />
          </>
        ) : null}
        {!loading && loadedOnce && rows.length === 0 && !err ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No ledger entries in this window.
          </div>
        ) : null}
        {rows.length > 0 ? (
          <>
            <div
              className="muted"
              style={{
                display: "grid",
                gridTemplateColumns: "1.4fr 1fr 1fr 0.7fr 0.8fr",
                gap: 8,
                fontSize: 11,
                padding: "4px 0",
                borderBottom: "1px solid var(--pw-border-soft)",
              }}
            >
              <span>When</span>
              <span>Kind</span>
              <span>Key</span>
              <span style={{ textAlign: "right" }}>Qty</span>
              <span style={{ textAlign: "right" }}>Cost</span>
            </div>
            {rows.map((e) => (
              <div
                key={e.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.4fr 1fr 1fr 0.7fr 0.8fr",
                  gap: 8,
                  fontSize: 12,
                  padding: "5px 0",
                  borderBottom: "1px solid var(--pw-border-soft)",
                }}
              >
                <span className="muted">{new Date(e.at).toLocaleString()}</span>
                <span className="mono" style={{ fontSize: 11 }}>
                  {e.kind}
                </span>
                <span
                  className="mono muted"
                  style={{
                    fontSize: 11,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.apiKeyId ?? "—"}
                </span>
                <span className="tabular" style={{ textAlign: "right" }}>
                  {fmtCount(e.quantity)}
                </span>
                <span className="tabular" style={{ textAlign: "right" }}>
                  {fmtCentsAsDollars(e.cents)}
                </span>
              </div>
            ))}
            {hasMore ? (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void loadPage(cursor)}
                  disabled={loading}
                >
                  {loading ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}
