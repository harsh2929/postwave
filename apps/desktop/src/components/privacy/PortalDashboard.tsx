/**
 * PortalDashboard — top-of-page KPI tiles for the Privacy Portal.
 *
 * Surfaces:
 *   - DSAR snapshot (open / overdue / closed totals across request types)
 *   - GPC-signaled subscribers
 *   - Do-not-sell subscribers
 *   - Double opt-in pending count
 *   - Suppression breakdown (top reasons)
 *   - DSAR rows per request type
 *
 * Pure presentational: takes a Summary and renders. No fetching here so
 * the parent page can re-trigger the summary load whenever a region is
 * added / removed without prop-drilling refresh handlers.
 */

import { type ReactElement } from "react";

import { StatStrip, type StatCell } from "../StatStrip";
import { type PrivacyPortalSummary } from "../../lib/api-client";
import { dsarTotals as computeDsarTotals } from "./portal-dashboard-helpers";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";

interface Props {
  summary: PrivacyPortalSummary;
}

export function PortalDashboard({ summary }: Props): ReactElement {
  // Every read here is defensive: the API can return a 200 with a partial
  // body (e.g. a brand-new workspace whose summary omits the array fields
  // entirely). Reading `.reduce` / `.slice` / `.toLocaleString()` off an
  // undefined field white-screens the whole portal, so default each one.
  const dsarRequests = summary.dsar_requests ?? [];
  const dsarTotals = computeDsarTotals(dsarRequests);

  const cells: StatCell[] = [
    {
      label: "DSAR · open",
      value: dsarTotals.open.toLocaleString(),
      hint: "Privacy requests (access / deletion / portability) not yet completed.",
    },
    {
      label: "DSAR · overdue",
      value: (
        <span
          style={{
            color: dsarTotals.overdue > 0 ? "var(--pw-danger)" : undefined,
          }}
        >
          {dsarTotals.overdue.toLocaleString()}
        </span>
      ),
      hint: "Open requests past their statutory due date (GDPR Art.12: 30d; CCPA: 45d).",
    },
    {
      label: "GPC signaled",
      value: (summary.gpc_signaled_count ?? 0).toLocaleString(),
      hint: "Subscribers whose browser sent the Global Privacy Control header.",
    },
    {
      label: "Do-not-sell",
      value: (summary.do_not_sell_count ?? 0).toLocaleString(),
      hint: "Subscribers with the do-not-sell preference enabled (CCPA §1798.135).",
    },
    {
      label: "Double opt-in · pending",
      value: (summary.double_optin_pending ?? 0).toLocaleString(),
      hint: "Tokens awaiting subscriber confirmation. Expires after 60 days.",
    },
  ];

  const topSuppression = (summary.suppression_breakdown ?? []).slice(0, 4);

  return (
    <div
      className="pw-data-visual"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <StatStrip cells={cells} />
      <AccessibleChartData
        title="Privacy-portal summary indicators"
        summary="Workspace privacy indicators covering open and overdue DSAR requests, GPC signals, do-not-sell preferences and pending double opt-in confirmations."
        rowHeaderLabel="Indicator"
        columns={[
          { key: "value", label: "Count" },
          { key: "unit", label: "Unit" },
        ]}
        rows={[
          privacyKpiRow(
            "dsar-open",
            "DSAR · open",
            dsarTotals.open,
            "requests",
          ),
          privacyKpiRow(
            "dsar-overdue",
            "DSAR · overdue",
            dsarTotals.overdue,
            "requests",
          ),
          privacyKpiRow(
            "gpc",
            "GPC signaled",
            summary.gpc_signaled_count ?? 0,
            "subscribers",
          ),
          privacyKpiRow(
            "do-not-sell",
            "Do-not-sell",
            summary.do_not_sell_count ?? 0,
            "subscribers",
          ),
          privacyKpiRow(
            "double-optin",
            "Double opt-in · pending",
            summary.double_optin_pending ?? 0,
            "pending confirmations",
          ),
        ]}
        provenance={dux025Provenance("privacyPortalKpis")}
        exportFileName="privacy-portal-summary-indicators.csv"
        exportPrivacy="confidential"
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 12,
        }}
      >
        <div
          className="card"
          style={{
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <header>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              DSAR by request type
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              Open / overdue / closed per privacy_requests.request_type.
            </div>
          </header>

          {dsarRequests.length === 0 ? (
            <div className="muted" style={{ fontSize: 12, padding: "6px 0" }}>
              No privacy requests on file.
            </div>
          ) : (
            <div className="list">
              <div
                className="list-header"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.4fr 60px 80px 60px",
                  padding: "6px 10px",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                <div>Request type</div>
                <div>Open</div>
                <div>Overdue</div>
                <div>Closed</div>
              </div>
              {dsarRequests.map((r) => (
                <div
                  key={r.request_type}
                  className="list-row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.4fr 60px 80px 60px",
                    alignItems: "center",
                    padding: "6px 10px",
                    fontSize: 12,
                  }}
                >
                  <div>{r.request_type}</div>
                  <div>{(r.open ?? 0).toLocaleString()}</div>
                  <div
                    style={{
                      color:
                        (r.overdue ?? 0) > 0 ? "var(--pw-danger)" : undefined,
                    }}
                  >
                    {(r.overdue ?? 0).toLocaleString()}
                  </div>
                  <div className="muted">
                    {(r.closed ?? 0).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
          {dsarRequests.length > 0 ? (
            <AccessibleChartData
              title="DSAR requests by request type and status"
              summary={`${dsarRequests.length} privacy-request types; ${dsarTotals.open.toLocaleString()} open, ${dsarTotals.overdue.toLocaleString()} overdue and ${dsarTotals.closed.toLocaleString()} closed requests in the current workspace summary.`}
              rowHeaderLabel="Request type"
              columns={[
                { key: "open", label: "Open requests" },
                { key: "overdue", label: "Overdue requests" },
                { key: "closed", label: "Closed requests" },
              ]}
              rows={dsarRequests.map((request) => ({
                key: request.request_type,
                label: request.request_type,
                values: {
                  open: (request.open ?? 0).toLocaleString(),
                  overdue: (request.overdue ?? 0).toLocaleString(),
                  closed: (request.closed ?? 0).toLocaleString(),
                },
                exportValues: {
                  open: request.open ?? 0,
                  overdue: request.overdue ?? 0,
                  closed: request.closed ?? 0,
                },
              }))}
              provenance={dux025Provenance("privacyDsarBreakdown")}
              exportFileName="privacy-dsar-requests-by-type.csv"
              exportPrivacy="confidential"
            />
          ) : null}
        </div>

        <div
          className="card"
          style={{
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <header>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              Suppressions · top reasons
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              Why subscribers are currently being filtered out at send time.
            </div>
          </header>

          {topSuppression.length === 0 ? (
            <div className="muted" style={{ fontSize: 12, padding: "6px 0" }}>
              No suppressions recorded.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topSuppression.map((s, idx) => {
                const count = s.count ?? 0;
                const max = topSuppression[0]?.count ?? 1;
                const pct = max > 0 ? Math.round((count / max) * 100) : 0;
                return (
                  // `reason` can be blank (rendered as "unknown") or repeat
                  // across buckets, so it is not a unique key — suffix the
                  // index to avoid React's duplicate-key reconciliation bug.
                  <div key={`${s.reason}:${idx}`}>
                    <div
                      aria-hidden="true"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12,
                        marginBottom: 2,
                      }}
                    >
                      <span>{s.reason || "unknown"}</span>
                      <span className="muted">{count.toLocaleString()}</span>
                    </div>
                    <div
                      style={{
                        height: 4,
                        background: "var(--pw-bg-elev-2)",
                        borderRadius: 999,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          background: "var(--pw-accent)",
                          backgroundImage:
                            "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {topSuppression.length > 0 ? (
            <AccessibleChartData
              title="Privacy-portal suppression reasons"
              summary={`${topSuppression.length} leading suppression reasons returned by the privacy summary. Bar widths are relative to the largest displayed reason.`}
              rowHeaderLabel="Suppression reason"
              columns={[
                { key: "count", label: "Suppressions" },
                {
                  key: "relative",
                  label: "Relative to displayed maximum (%)",
                },
              ]}
              rows={topSuppression.map((suppression, index) => {
                const count = suppression.count ?? 0;
                const max = topSuppression[0]?.count ?? 0;
                return {
                  key: `${suppression.reason}:${index}`,
                  label: suppression.reason || "unknown",
                  values: {
                    count: count.toLocaleString(),
                    relative:
                      max > 0
                        ? `${((count / max) * 100).toFixed(1)}%`
                        : "Unavailable",
                  },
                  exportValues: {
                    count,
                    relative: max > 0 ? (count / max) * 100 : null,
                  },
                };
              })}
              provenance={dux025Provenance("privacySuppressionReasons")}
              exportFileName="privacy-portal-suppression-reasons.csv"
              exportPrivacy="confidential"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function privacyKpiRow(
  key: string,
  label: string,
  value: number,
  unit: string,
) {
  return {
    key,
    label,
    values: { value: value.toLocaleString(), unit },
    exportValues: { value, unit },
  };
}
