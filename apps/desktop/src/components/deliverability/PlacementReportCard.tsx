/**
 * PlacementReportCard — #42 of the 2026-06-11 wiring backlog.
 *
 * Seed-test placement report per campaign (proxied GET
 * /api/v1/inbox-reality/campaigns/{id}): overall placement
 * distribution (primary / promotions / spam / …) rendered as a
 * stacked bar + legend (same idiom as BounceClassBreakdownChart) and
 * the per-provider count table underneath.
 *
 * Wire honesty:
 *   404 → no seed test has reported for the campaign yet (real
 *         empty state);
 *   503 → deliverability service not configured on this deployment
 *         (explicit notice, NOT an empty state).
 * The wire shape carries placements + seed totals only — there are no
 * seed open/click/bounce rates in this report, so none are invented.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import {
  type CampaignPlacementReport,
  inboxRealityCampaignsApi,
} from "../../lib/api-client";
import { CategoricalDistributionChart } from "../charts/CategoricalDistributionChart";
import { Notice } from "../Notice";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import { CampaignSelect } from "./CampaignSelect";
import {
  placementColor,
  placementLabel,
  placementRows,
  providerPlacementTable,
  type ProviderPlacementRow,
} from "./placement-report-helpers";
import { describeServiceError, type ServiceErrorView } from "./service-status";
import { parsePlacementReport } from "./diagnostics-response-contract";

export function PlacementReportCard(): ReactElement {
  const [campaignId, setCampaignId] = useState("");
  const [report, setReport] = useState<CampaignPlacementReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [errView, setErrView] = useState<ServiceErrorView | null>(null);
  const requestIdRef = useRef(0);
  const reportCampaignRef = useRef<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;
    if (!campaignId) {
      setReport(null);
      setErrView(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setErrView(null);
    if (reportCampaignRef.current !== campaignId) setReport(null);
    try {
      const res = await inboxRealityCampaignsApi.report(campaignId);
      if (requestId !== requestIdRef.current) return;
      if (res.error) {
        setErrView(describeServiceError(res.error));
      } else {
        const parsed = parsePlacementReport(res.data, campaignId);
        if (!parsed) {
          setErrView({
            kind: "error",
            message: "Placement report service returned a malformed response.",
          });
        } else {
          reportCampaignRef.current = campaignId;
          setReport(parsed);
        }
      }
    } catch {
      if (requestId === requestIdRef.current) {
        setErrView({
          kind: "error",
          message: "Moosewave couldn't load the placement report.",
        });
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load]);

  const rows = report ? placementRows(report.overall_pct) : [];
  const providerTable = report ? providerPlacementTable(report) : null;
  const providerColumns: readonly DataTableColumn<ProviderPlacementRow>[] =
    providerTable
      ? [
          {
            id: "provider",
            header: "Provider",
            width: "200px",
            cell: (row) => (
              <span style={{ fontWeight: 500 }}>
                {row.provider.replace(/_/g, " ")}
              </span>
            ),
          },
          ...providerTable.columns.map((code, index) => ({
            id: code,
            header: placementLabel(code),
            align: "end" as const,
            cell: (row: ProviderPlacementRow) =>
              row.cells[index]?.count.toLocaleString() ?? "0",
          })),
          {
            id: "total",
            header: "Total",
            align: "end" as const,
            cell: (row: ProviderPlacementRow) => row.total.toLocaleString(),
          },
        ]
      : [];

  return (
    <div className="card" style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontWeight: 600 }}>Campaign placement report</div>
          <div className="muted" style={{ fontSize: 12 }}>
            Where the seed-test inboxes saw the campaign land
          </div>
        </div>
        <div style={{ minWidth: 220 }}>
          <CampaignSelect
            id="placement-report-campaign"
            ariaLabel="Campaign for placement report"
            value={campaignId}
            onChange={setCampaignId}
            disabled={loading}
          />
        </div>
      </div>

      {errView && report ? (
        <Notice
          tone={
            errView.kind === "not_found"
              ? "neutral"
              : errView.kind === "unconfigured"
                ? "warning"
                : "danger"
          }
          announcement={
            errView.kind === "error" || errView.kind === "rate_limited"
              ? "assertive"
              : "polite"
          }
          style={{ marginBottom: 10 }}
        >
          Couldn&apos;t refresh the placement report: {errView.message}. Showing
          the last verified report.
        </Notice>
      ) : null}

      {!campaignId ? (
        <div
          className="muted"
          style={{ padding: 20, textAlign: "center", fontSize: 13 }}
        >
          Pick a campaign to load its seed-test placement report.
        </div>
      ) : loading && !report ? (
        <>
          <div className="skel" style={{ height: 24, width: "100%" }} />
          <div className="skel-row" style={{ marginTop: 8 }} />
        </>
      ) : errView && !report ? (
        <Notice
          tone={
            errView.kind === "not_found"
              ? "neutral"
              : errView.kind === "unconfigured"
                ? "warning"
                : "danger"
          }
          announcement={
            errView.kind === "error" || errView.kind === "rate_limited"
              ? "assertive"
              : "polite"
          }
          action={
            errView.kind === "error" || errView.kind === "rate_limited" ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void load()}
              >
                Retry
              </button>
            ) : null
          }
        >
          {errView.kind === "not_found"
            ? "No seed test has reported for this campaign yet — run an Inbox Reality test first."
            : errView.message}
        </Notice>
      ) : !report ? null : (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {report.total_inboxes.toLocaleString()} seed inbox(es) · generated{" "}
            {new Date(report.generated_at).toLocaleString()}
          </div>

          {/* Stacked placement bar (same idiom as the bounce chart). */}
          {rows.length === 0 ? (
            <div
              className="muted"
              style={{ padding: 16, textAlign: "center", fontSize: 13 }}
            >
              The report carries no placement percentages.
            </div>
          ) : (
            <CategoricalDistributionChart
              title="Seed inbox placement distribution"
              valueLabel="Placement percentage"
              formatValue={(value) => `${value.toFixed(1)}%`}
              segments={rows.map((row) => ({
                key: row.code,
                label: row.label,
                value: row.pct,
                share: row.pct / 100,
                color: placementColor(row.code),
              }))}
              provenance={{
                source: "Moosewave Inbox Reality API",
                asOf: report.generated_at,
                scope: `${report.total_inboxes.toLocaleString()} seed inboxes for the selected campaign`,
              }}
              exportFileName="seed-inbox-placement-distribution.csv"
              exportPrivacy="confidential"
            />
          )}

          {/* Per-provider counts. */}
          {providerTable && providerTable.rows.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <DataTable
                caption="Placement counts by provider"
                description={`${report.total_inboxes.toLocaleString()} seed inboxes for the selected campaign`}
                columns={providerColumns}
                rows={providerTable.rows}
                getRowKey={(row) => row.provider}
                density="compact"
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
