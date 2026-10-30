/**
 * SegmentOverlapCard — pick two saved segments and visualize their
 * member overlap (R11: GET /api/v1/segments/overlap?a=&b=).
 *
 * Renders a proportional two-circle Euler diagram (pure SVG, design
 * tokens only — geometry solved in overlap-helpers.ts) plus the raw
 * counts and the Jaccard index, all verbatim from the server.
 *
 * Composed onto the Segments page below the saved-segment list; the
 * page owns the segment rows, this card only needs {id, name}.
 */

import { type ReactElement, useId, useRef, useState } from "react";

import {
  type SegmentOverlapResponse,
  segmentInsightsApi,
} from "../../lib/api-client";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import type { Segment } from "./segmentsClient";
import { fmtJaccard, overlapLayout, overlapSummary } from "./overlap-helpers";

interface Props {
  segments: Segment[];
}

const SVG_W = 320;
const SVG_H = 160;

export function SegmentOverlapCard({ segments }: Props): ReactElement {
  const [aId, setAId] = useState("");
  const [bId, setBId] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<SegmentOverlapResponse | null>(null);
  const requestVersion = useRef(0);
  const activePairRef = useRef<string | null>(null);
  const compareReasonId = useId();

  const nameOf = (id: string): string =>
    segments.find((s) => s.id === id)?.name || id;
  const compareUnavailableReason = loading
    ? "A segment overlap comparison is already in progress."
    : !aId || !bId
      ? "Choose two segments to compare."
      : aId === bId
        ? "Choose two different segments."
        : null;

  const compare = async (): Promise<void> => {
    if (!aId || !bId || aId === bId) return;
    const pair = `${aId}\u0000${bId}`;
    if (activePairRef.current === pair) return;
    activePairRef.current = pair;
    const version = ++requestVersion.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await segmentInsightsApi.overlap(aId, bId);
      if (version !== requestVersion.current) return;
      activePairRef.current = null;
      setLoading(false);
      if (res.error) {
        setResult(null);
        setErr(
          res.error.kind === "http" && res.error.status === 404
            ? "One of the segments no longer exists on the server — refresh the list."
            : res.error.message,
        );
        return;
      }
      setResult(res.data);
    } catch (requestError) {
      if (version !== requestVersion.current) return;
      activePairRef.current = null;
      setLoading(false);
      setResult(null);
      setErr(
        requestError instanceof Error
          ? requestError.message
          : "Segment overlap request failed.",
      );
    }
  };

  const clearComparison = (): void => {
    requestVersion.current += 1;
    activePairRef.current = null;
    setLoading(false);
    setResult(null);
    setErr(null);
  };

  const layout = result
    ? overlapLayout(
        result.a_count,
        result.b_count,
        result.intersection,
        SVG_W,
        SVG_H,
      )
    : null;

  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "10px 12px",
        marginTop: 16,
        background: "var(--pw-bg-elev)",
      }}
      role="region"
      aria-label="Segment overlap"
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        Segment overlap
      </div>
      {segments.length < 2 ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          Save at least two segments to compare their membership.
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
              style={{ maxWidth: 200, fontSize: 12 }}
              value={aId}
              onChange={(e) => {
                setAId(e.target.value);
                clearComparison();
              }}
              aria-label="First segment"
            >
              <option value="">Pick segment A…</option>
              {segments.map((s) => (
                <option key={s.id} value={s.id} disabled={s.id === bId}>
                  {s.name || "Unnamed segment"}
                </option>
              ))}
            </select>
            <span className="muted" style={{ fontSize: 11 }}>
              vs
            </span>
            <select
              className="input"
              style={{ maxWidth: 200, fontSize: 12 }}
              value={bId}
              onChange={(e) => {
                setBId(e.target.value);
                clearComparison();
              }}
              aria-label="Second segment"
            >
              <option value="">Pick segment B…</option>
              {segments.map((s) => (
                <option key={s.id} value={s.id} disabled={s.id === aId}>
                  {s.name || "Unnamed segment"}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (compareUnavailableReason) return;
                void compare();
              }}
              aria-disabled={compareUnavailableReason ? true : undefined}
              aria-describedby={
                compareUnavailableReason ? compareReasonId : undefined
              }
            >
              {loading ? "Comparing…" : "Compare"}
            </button>
          </div>
          {compareUnavailableReason ? (
            <p
              id={compareReasonId}
              className="muted"
              style={{ fontSize: 11, margin: "6px 0 0" }}
            >
              {compareUnavailableReason}
            </p>
          ) : null}

          {err ? (
            <div className="field-error" style={{ marginTop: 6 }} role="alert">
              {err}
            </div>
          ) : null}

          {loading ? (
            <div className="muted" role="status" style={{ marginTop: 6 }}>
              Comparing current segment memberships…
            </div>
          ) : null}

          {result && layout ? (
            <SegmentOverlapResult
              result={result}
              layout={layout}
              nameOf={nameOf}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function SegmentOverlapResult({
  result,
  layout,
  nameOf,
}: {
  result: SegmentOverlapResponse;
  layout: ReturnType<typeof overlapLayout>;
  nameOf: (id: string) => string;
}): ReactElement {
  const aOnly = Math.max(0, result.a_count - result.intersection);
  const bOnly = Math.max(0, result.b_count - result.intersection);
  const union = Math.max(
    0,
    result.a_count + result.b_count - result.intersection,
  );

  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        alignItems: "center",
        marginTop: 10,
        flexWrap: "wrap",
      }}
    >
      {layout.degenerate ? (
        <div className="muted" style={{ fontSize: 12, width: SVG_W }}>
          {overlapSummary(result.a_count, result.b_count, result.intersection)}
        </div>
      ) : (
        <svg
          width="100%"
          height={SVG_H}
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          aria-hidden="true"
          focusable="false"
          style={{ display: "block", maxWidth: SVG_W }}
        >
          <circle
            cx={layout.a.cx}
            cy={layout.a.cy}
            r={layout.a.r}
            fill="color-mix(in srgb, var(--pw-accent) 25%, transparent)"
            stroke="var(--pw-accent)"
            strokeWidth="1.5"
          />
          <circle
            cx={layout.b.cx}
            cy={layout.b.cy}
            r={layout.b.r}
            fill="color-mix(in srgb, var(--pw-success) 25%, transparent)"
            stroke="var(--pw-success)"
            strokeWidth="1.5"
            strokeDasharray="7 4"
          />
        </svg>
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          fontSize: 12,
          minWidth: 220,
        }}
      >
        <div>
          <span aria-hidden="true" style={{ color: "var(--pw-accent)" }}>
            ●{" "}
          </span>
          <span style={{ fontWeight: 500 }}>{nameOf(result.a)}</span>
          <span className="muted tabular">
            {" "}
            · {result.a_count.toLocaleString()}
          </span>
        </div>
        <div>
          <span aria-hidden="true" style={{ color: "var(--pw-success)" }}>
            ◇{" "}
          </span>
          <span style={{ fontWeight: 500 }}>{nameOf(result.b)}</span>
          <span className="muted tabular">
            {" "}
            · {result.b_count.toLocaleString()}
          </span>
        </div>
        <div className="muted">
          {overlapSummary(result.a_count, result.b_count, result.intersection)}
        </div>
        <div className="muted tabular">
          Jaccard similarity: {fmtJaccard(result.jaccard)}
        </div>
      </div>
      <div style={{ flexBasis: "100%", minWidth: 0 }}>
        <AccessibleChartData
          title="Segment membership overlap"
          summary={`${nameOf(result.a)} has ${result.a_count.toLocaleString()} members; ${nameOf(result.b)} has ${result.b_count.toLocaleString()}; ${result.intersection.toLocaleString()} subscribers are shared; Jaccard similarity is ${fmtJaccard(result.jaccard)}.`}
          rowHeaderLabel="Measure"
          columns={[
            { key: "value", label: "Value" },
            { key: "unit", label: "Unit" },
          ]}
          rows={[
            overlapDataRow("segment-a", nameOf(result.a), result.a_count),
            overlapDataRow("segment-b", nameOf(result.b), result.b_count),
            overlapDataRow("shared", "Shared membership", result.intersection),
            overlapDataRow("a-only", `${nameOf(result.a)} only`, aOnly),
            overlapDataRow("b-only", `${nameOf(result.b)} only`, bOnly),
            overlapDataRow("union", "Union", union),
            {
              key: "jaccard",
              label: "Jaccard similarity",
              values: {
                value: fmtJaccard(result.jaccard),
                unit: "percent",
              },
              exportValues: {
                value: result.jaccard,
                unit: "fraction",
              },
            },
          ]}
          provenance={dux025Provenance("segmentOverlap", {
            scope: `${nameOf(result.a)} vs ${nameOf(result.b)} · current workspace`,
          })}
          exportFileName="segment-membership-overlap.csv"
          exportPrivacy="confidential"
        />
      </div>
    </div>
  );
}

function overlapDataRow(key: string, label: string, value: number) {
  return {
    key,
    label,
    values: { value: value.toLocaleString(), unit: "subscribers" },
    exportValues: { value, unit: "subscribers" },
  };
}
