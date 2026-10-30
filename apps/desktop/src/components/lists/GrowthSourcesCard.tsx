/** Workspace-wide growth-source acquisition and quality analytics. */

import { type ReactElement, useCallback, useId, useRef, useState } from "react";

import {
  type RemoteLoadResult,
  useRemoteResource,
} from "../../hooks/useRemoteResource";
import {
  type GrowthSourceQualityResponse,
  type GrowthSourceSummaryResponse,
  type GrowthSourceTimeseriesResponse,
  growthSourcesApi,
} from "../../lib/api/growth-sources";
import { isInitialRemoteLoad } from "../../lib/remote-resource";
import { ChoiceGroup } from "../ChoiceGroup";
import { Donut } from "../charts/Donut";
import { MultiLineChart } from "../charts/MultiLineChart";
import { RemoteDataNotice } from "../RemoteDataNotice";
import { SectionHeader } from "../SectionHeader";
import {
  donutSlicesFromSummary,
  fmtRate01,
  seriesFromTimeseries,
  sourceLabel,
} from "./growth-sources-helpers";

import "../../styles-growth-sources.css";

const WINDOWS = [30, 60, 90] as const;
type WindowDays = (typeof WINDOWS)[number];

interface GrowthSourceBundle {
  summary: GrowthSourceSummaryResponse;
  timeseries: GrowthSourceTimeseriesResponse;
  quality: GrowthSourceQualityResponse;
}

async function loadGrowthSourceBundle(
  days: WindowDays,
): Promise<RemoteLoadResult<GrowthSourceBundle>> {
  const [summary, timeseries, quality] = await Promise.all([
    growthSourcesApi.summary(days),
    growthSourcesApi.timeseries(days),
    growthSourcesApi.quality(days),
  ]);
  const error = summary.error ?? timeseries.error ?? quality.error;
  if (error) return { error };
  if (!summary.data || !timeseries.data || !quality.data) {
    return {
      error: {
        kind: "parse",
        message: "Incomplete growth-source response",
      },
    };
  }
  return {
    data: {
      summary: summary.data,
      timeseries: timeseries.data,
      quality: quality.data,
    },
  };
}

export function GrowthSourcesCard(): ReactElement {
  const [days, setDays] = useState<WindowDays>(30);
  const resource = useRemoteResource<GrowthSourceBundle>(
    () => loadGrowthSourceBundle(days),
    { identity: `growth-sources:${days}` },
  );
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refreshHelpId = useId();
  const refresh = useCallback(async (): Promise<void> => {
    if (refreshPromiseRef.current) {
      await refreshPromiseRef.current;
      return;
    }
    let tracked: Promise<void>;
    tracked = resource.reload().finally(() => {
      if (refreshPromiseRef.current === tracked)
        refreshPromiseRef.current = null;
    });
    refreshPromiseRef.current = tracked;
    await tracked;
  }, [resource.reload]);

  return (
    <section className="growth-sources" aria-label="Growth sources">
      <SectionHeader
        title="Growth sources"
        description="Where new subscribers came from and how each signup channel performs. Workspace-wide, across all lists."
        helpText="Source is the consent_source recorded at signup. Rates are each source's engaged, bounced, or complained subscribers divided by that source's verified subscriber total in the selected window."
        actions={
          <div className="growth-sources-controls">
            <ChoiceGroup
              legend="Growth-source reporting window"
              value={String(days)}
              onChange={(value) => setDays(Number(value) as WindowDays)}
              className="chips"
              optionClassName="chip"
              options={WINDOWS.map((windowDays) => ({
                value: String(windowDays),
                label: `${windowDays} days`,
                className: days === windowDays ? "is-active" : undefined,
                description:
                  days === windowDays
                    ? "Current reporting window"
                    : `Switch to the last ${windowDays} days`,
              }))}
            />
            <button
              type="button"
              className="btn btn-sm pw-discoverable-unavailable"
              onClick={() => {
                if (resource.transport !== "loading") void refresh();
              }}
              aria-disabled={resource.transport === "loading" || undefined}
              aria-busy={resource.transport === "loading" ? "true" : undefined}
              aria-describedby={refreshHelpId}
            >
              {resource.transport === "loading" ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        }
      />

      <p id={refreshHelpId} className="pw-action-status" role="status">
        {resource.transport === "loading"
          ? resource.data
            ? `Refreshing the last ${days} days; the previous verified bundle remains visible.`
            : `Loading the last ${days} days of workspace-wide acquisition data.`
          : `Showing the last ${days} days across every list in the current workspace.`}
      </p>

      <RemoteDataNotice
        resource={resource}
        label="growth-source analytics"
        onRetry={() => void refresh()}
      />

      {isInitialRemoteLoad(resource) ? (
        <div className="growth-sources-loading" role="status" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="skel-row" />
          ))}
        </div>
      ) : resource.data ? (
        <GrowthSourceContent data={resource.data} requestedDays={days} />
      ) : (
        <div className="growth-sources-empty" role="status">
          Growth-source analytics are unavailable. Retry to verify this window.
        </div>
      )}
    </section>
  );
}

function GrowthSourceContent({
  data,
  requestedDays,
}: {
  data: GrowthSourceBundle;
  requestedDays: WindowDays;
}): ReactElement {
  const slices = donutSlicesFromSummary(
    Array.isArray(data.summary.sources) ? data.summary.sources : [],
  );
  const series = seriesFromTimeseries(
    Array.isArray(data.timeseries.points) ? data.timeseries.points : [],
  );
  const qualityRows = Array.isArray(data.quality.sources)
    ? data.quality.sources
    : [];
  const summaryDays = data.summary.window_days ?? requestedDays;
  const seriesDays = data.timeseries.window_days ?? requestedDays;

  return (
    <div className="growth-sources-content">
      <div className="growth-sources-charts">
        <div className="card growth-sources-chart-card">
          <h3>New subscribers · last {summaryDays} days</h3>
          {slices.length > 0 ? (
            <Donut
              slices={slices}
              centerLabel={`new sub${(data.summary.total_new_subs ?? 0) === 1 ? "" : "s"}`}
              title="New subscribers by growth source"
              valueLabel="Subscribers"
              provenance={{
                source: "Moosewave growth-source summary API",
                asOf: null,
                scope: `Current workspace · all lists · last ${summaryDays} days`,
                note: "Source is the consent_source recorded at signup; empty source values are labelled untracked.",
              }}
              exportFileName="new-subscribers-by-growth-source.csv"
              exportPrivacy="confidential"
            />
          ) : (
            <div className="pw-chart-empty">
              No new subscribers recorded in this window.
            </div>
          )}
        </div>

        <div className="card growth-sources-chart-card">
          <h3>Daily signups by source</h3>
          {series.length > 0 &&
          series.some((item) =>
            item.values.some((value) => value.count > 0),
          ) ? (
            <MultiLineChart
              series={series}
              height={200}
              title="Daily signups by source"
              valueLabel="Subscribers"
              provenance={{
                source: "Moosewave growth-source timeseries API",
                asOf: null,
                scope: `Current workspace · all lists · last ${seriesDays} days`,
                note: "Top source series use the server-provided daily buckets.",
              }}
              exportFileName="daily-signups-by-source.csv"
              exportPrivacy="confidential"
            />
          ) : (
            <div className="pw-chart-empty">
              No signup activity in this window.
            </div>
          )}
        </div>
      </div>

      <GrowthSourceQualityTable
        rows={qualityRows}
        days={data.quality.window_days ?? requestedDays}
      />
    </div>
  );
}

function GrowthSourceQualityTable({
  rows,
  days,
}: {
  rows: NonNullable<GrowthSourceQualityResponse["sources"]>;
  days: number;
}): ReactElement {
  return (
    <div className="card growth-sources-quality-card">
      <h3>Source quality</h3>
      <p className="pw-action-status">
        Each rate includes its numerator and verified source total for the last{" "}
        {days} days.
      </p>
      {rows.length === 0 ? (
        <div className="pw-chart-empty">
          No source-quality data for this window.
        </div>
      ) : (
        <div className="growth-sources-table-scroll">
          <table className="growth-sources-quality-table">
            <caption>
              Workspace-wide subscriber quality by recorded consent source ·
              last {days} days
            </caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Subscribers</th>
                <th scope="col">Engaged</th>
                <th scope="col">Bounced</th>
                <th scope="col">Complained</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.consent_source || "untracked"}:${index}`}>
                  <th scope="row">
                    <strong>{sourceLabel(row.consent_source)}</strong>
                    <small className="muted">
                      {row.consent_source
                        ? `Recorded value: ${row.consent_source}`
                        : "No consent_source recorded"}
                    </small>
                  </th>
                  <td className="tabular">
                    {(row.total_subscribers ?? 0).toLocaleString()}
                  </td>
                  <QualityMetric
                    rate={row.engagement_rate}
                    count={row.engaged ?? 0}
                    noun="engaged"
                  />
                  <QualityMetric
                    rate={row.bounce_rate}
                    count={row.bounced ?? 0}
                    noun="bounced"
                  />
                  <QualityMetric
                    rate={row.complaint_rate}
                    count={row.complained ?? 0}
                    noun="complained"
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function QualityMetric({
  rate,
  count,
  noun,
}: {
  rate: number;
  count: number;
  noun: string;
}): ReactElement {
  return (
    <td className="tabular">
      <strong>{fmtRate01(rate)}</strong>
      <small className="muted">
        {count.toLocaleString()} {noun}
      </small>
    </td>
  );
}
