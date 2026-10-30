/**
 * SnapshotHistoryCard — renders the per-tenant score history sampled
 * by the deliverability_hub worker into deliverability_hub_snapshots.
 *
 * Sparkline gives an at-a-glance trend; min / max / avg below the line
 * are the operator's quick read on the rolling window. Defaults to the
 * 30-day window the API returns; we accept whatever days came back so
 * the card stays in sync with the endpoint default.
 *
 * Wired from infra/migrations/0334_deliverability_hub_tables.sql.
 */

import type { ReactElement } from "react";

import { Sparkline } from "../charts/Sparkline";
import type { DeliverabilityHubHistoryResponse } from "../../lib/api-client";

interface Props {
  data: DeliverabilityHubHistoryResponse | null;
  loading: boolean;
}

export function SnapshotHistoryCard({ data, loading }: Props): ReactElement {
  if (loading && !data) {
    return (
      <div className="card" style={{ padding: 20 }}>
        <div
          className="muted"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          Score history
        </div>
        <div className="skel" style={{ height: 56, marginTop: 12 }} />
      </div>
    );
  }

  const snapshots = data?.snapshots ?? [];
  if (snapshots.length === 0) {
    return (
      <div className="card" style={{ padding: 20 }}>
        <div
          className="muted"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          Score history
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          No current-model snapshots are recorded yet. The hub worker samples
          every hour, and qualified history will populate after the campaign
          send floor is reached.
        </div>
      </div>
    );
  }

  const qualifiedSnapshots = snapshots.filter(
    (snapshot) => snapshot.sample_qualified,
  );
  const excludedCount = snapshots.length - qualifiedSnapshots.length;
  if (qualifiedSnapshots.length === 0) {
    const latest = snapshots[snapshots.length - 1];
    return (
      <div className="card" style={{ padding: 20 }}>
        <div
          className="muted"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          Qualified score history
        </div>
        <div style={{ fontWeight: 600, marginTop: 8 }}>
          No comparable samples yet
        </div>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
          {snapshots.length.toLocaleString()} current-model observation
          {snapshots.length === 1 ? " is" : "s are"} retained for evidence, but
          none reached the campaign-send floor. The latest contains{" "}
          {(latest?.sample_size ?? 0).toLocaleString()} successful campaign
          sends.
        </p>
      </div>
    );
  }

  const values = qualifiedSnapshots.map((s) => s.score);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const delta = last - first;
  const trend: "up" | "down" | "flat" =
    delta > 1 ? "up" : delta < -1 ? "down" : "flat";
  const windowDays = data?.window_days ?? 30;
  const firstSampled = qualifiedSnapshots[0]?.sampled_at;
  const lastSampled =
    qualifiedSnapshots[qualifiedSnapshots.length - 1]?.sampled_at;

  return (
    <div className="card" style={{ padding: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            className="muted"
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.6,
            }}
          >
            Qualified score history
          </div>
          <div style={{ fontWeight: 600, marginTop: 4 }}>
            Last {windowDays} days ·{" "}
            {qualifiedSnapshots.length.toLocaleString()} comparable sample
            {qualifiedSnapshots.length === 1 ? "" : "s"}
          </div>
        </div>
        <Sparkline values={values} width={220} height={56} trend={trend} fill />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 12,
          marginTop: 16,
          fontSize: 12,
        }}
      >
        <div>
          <div className="muted">Min</div>
          <div className="tabular" style={{ fontWeight: 600 }}>
            {min}
          </div>
        </div>
        <div>
          <div className="muted">Avg</div>
          <div className="tabular" style={{ fontWeight: 600 }}>
            {avg}
          </div>
        </div>
        <div>
          <div className="muted">Max</div>
          <div className="tabular" style={{ fontWeight: 600 }}>
            {max}
          </div>
        </div>
        <div>
          <div className="muted">Δ vs first</div>
          <div className="tabular" style={{ fontWeight: 600 }}>
            {delta > 0 ? `+${delta}` : delta}
          </div>
        </div>
      </div>
      {firstSampled && lastSampled ? (
        <div className="subtle" style={{ marginTop: 8, fontSize: 11 }}>
          {new Date(firstSampled).toLocaleDateString()} →{" "}
          {new Date(lastSampled).toLocaleDateString()}
        </div>
      ) : null}
      <div className="subtle" style={{ marginTop: 6, fontSize: 11 }}>
        Current model only
        {excludedCount > 0
          ? ` · ${excludedCount.toLocaleString()} unqualified observation${excludedCount === 1 ? "" : "s"} excluded from the chart`
          : ""}
      </div>
    </div>
  );
}
