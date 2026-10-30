/**
 * SegmentGrowthCard — per-segment member-count history sparkline
 * (R11: GET /api/v1/segments/{id}/growth?days=).
 *
 * The series comes from background snapshots, so early tenants will
 * see sparse or empty data — the server explains why via the `note`
 * field, which we render verbatim whenever present (honest-UI).
 * delta/delta_pct compare newest vs oldest snapshot in the window and
 * are structurally zero below 2 points; growthDeltaCopy labels that
 * case "not enough snapshots" instead of a misleading "no change".
 *
 * Composed onto the Segments page (the SegmentDetailSlideover belongs
 * to earlier work — we extend by page-level composition, not by
 * editing it).
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type SegmentGrowthResponse,
  segmentInsightsApi,
} from "../../lib/api-client";
import { LineChart } from "../charts/LineChart";
import type { Segment } from "./segmentsClient";
import { growthCaption, growthDeltaCopy } from "./segment-growth-helpers";

interface Props {
  segments: Segment[];
}

const WINDOWS = [30, 90, 365] as const;
const SVG_H = 72;

export function SegmentGrowthCard({ segments }: Props): ReactElement {
  const [segId, setSegId] = useState("");
  const [days, setDays] = useState<number>(90);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resp, setResp] = useState<SegmentGrowthResponse | null>(null);

  useEffect(() => {
    if (!segId) {
      setResp(null);
      setErr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await segmentInsightsApi.growth(segId, { days });
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        setResp(null);
        setErr(
          res.error.kind === "http" && res.error.status === 404
            ? "This segment no longer exists on the server — refresh the list."
            : res.error.message,
        );
        return;
      }
      setResp(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [segId, days]);

  const series = resp?.series ?? [];
  const counts = series.map((point) => point.count);
  const minCount = counts.length > 0 ? Math.min(...counts) : 0;
  const maxCount = counts.length > 0 ? Math.max(...counts) : 0;
  const delta = resp
    ? growthDeltaCopy(series, resp.delta, resp.delta_pct)
    : null;
  const deltaColor =
    delta?.tone === "up"
      ? "var(--pw-success)"
      : delta?.tone === "down"
        ? "var(--pw-danger)"
        : "var(--pw-fg-muted)";

  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "10px 12px",
        marginTop: 12,
        background: "var(--pw-bg-elev)",
      }}
      role="region"
      aria-label="Segment growth"
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        Segment growth
      </div>
      {segments.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Save a segment to track its member count over time.
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <select
              className="input"
              style={{ maxWidth: 220, fontSize: 12 }}
              value={segId}
              onChange={(e) => setSegId(e.target.value)}
              aria-label="Segment to chart"
            >
              <option value="">Pick a segment…</option>
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || "Unnamed segment"}
                </option>
              ))}
            </select>
            <div className="chips">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`chip${days === w ? " is-active" : ""}`}
                  onClick={() => setDays(w)}
                >
                  {w}d
                </button>
              ))}
            </div>
          </div>

          {err ? (
            <div className="field-error" style={{ marginTop: 6 }}>
              {err}
            </div>
          ) : null}

          {loading ? (
            <div className="skel" style={{ height: SVG_H, marginTop: 8 }} />
          ) : resp ? (
            <div style={{ marginTop: 8 }}>
              {/* Server note — explains sparse/empty series (snapshots
                  are taken by a background worker). Rendered verbatim. */}
              {resp.note ? (
                <div
                  className="notice"
                  style={{ fontSize: 11, padding: "4px 8px", marginBottom: 6 }}
                >
                  {resp.note}
                </div>
              ) : null}
              {series.length >= 2 ? (
                <LineChart
                  data={series}
                  height={120}
                  title="Segment member-count history"
                  valueLabel="Members"
                  summary={`${series.length} snapshots over ${resp.days} days. ${delta?.label ?? "Change unavailable"}.`}
                  provenance={{
                    source: "Moosewave segment snapshot API",
                    asOf: null,
                    scope: `Selected segment · last ${resp.days} days`,
                    note:
                      resp.note ||
                      "Background snapshot cadence determines available points.",
                  }}
                  exportFileName="segment-member-count-history.csv"
                  exportPrivacy="confidential"
                />
              ) : series.length === 1 ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  One snapshot so far ({series[0]!.date}:{" "}
                  {series[0]!.count.toLocaleString()} members) — a trend line
                  needs at least two.
                </div>
              ) : null}
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                  fontSize: 11,
                  marginTop: 4,
                  flexWrap: "wrap",
                }}
              >
                <span className="muted">
                  {growthCaption(series, resp.days)}
                </span>
                {delta ? (
                  <span
                    className="tabular"
                    style={{ color: deltaColor }}
                    title="Newest vs oldest snapshot in the window"
                  >
                    {delta.label}
                  </span>
                ) : null}
                {series.length >= 2 ? (
                  <span className="muted tabular">
                    range {minCount.toLocaleString()}–
                    {maxCount.toLocaleString()}
                  </span>
                ) : null}
              </div>
            </div>
          ) : segId === "" ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Pick a segment to see its snapshot history.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
