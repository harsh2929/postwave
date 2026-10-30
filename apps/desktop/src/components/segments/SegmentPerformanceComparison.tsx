/**
 * SegmentPerformanceComparison — SUB-036 audience performance dashboard.
 *
 * A modal (NOT a new route, mirroring SegmentCompareView's decision) that
 * compares 2–5 segments across BOTH the economic pillars (revenue, RPR
 * from /segments/pnl/compare) AND the engagement pillars an audience view
 * needs: open / click / unsub rates (/segments/{id}/engagement-summary)
 * and the net growth delta over the window (/segments/{id}/growth). Where
 * SegmentCompareView focuses on P&L economics, this surface adds the
 * audience-health metrics alongside.
 *
 * Honest-UI: rates come from delivery-outcome events for members in the
 * window (rate_basis), so a 0-send segment shows "—" rather than a
 * fabricated 0%. Per-column member counts use ComputedFrom; the growth
 * delta is structurally — below 2 snapshots (the worker hasn't run twice
 * yet) rather than a misleading "no change". Each metric loads
 * independently so a single failing call doesn't blank the whole table.
 */

import { type ReactElement, useState } from "react";

import { ComputedFrom } from "../common/Provenance";
import { Modal } from "../Modal";
import { fmtMoneyCents } from "../../lib/segment-pnl-helpers";
import type { Segment } from "./segmentsClient";
import {
  type SegmentEngagementSummary,
  type SegmentPnLResponse,
  segmentPnlClient,
} from "./segmentPnlClient";
import { segmentInsightsApi } from "../../lib/api-client";

const DAY_CHOICES = [30, 90, 365] as const;
const MAX_SEGMENTS = 5;
const PERFORMANCE_DESCRIPTION =
  "Compare two to five segments across revenue, revenue per recipient, engagement rates, and audience growth over one window.";

/** Per-segment growth delta over the window (newest vs oldest snapshot). */
interface GrowthDelta {
  delta: number;
  deltaPct: number;
  snapshots: number;
}

interface PerfRow {
  pnl?: SegmentPnLResponse;
  engagement?: SegmentEngagementSummary;
  growth?: GrowthDelta;
}

function fmtRate(rate: number | null | undefined, hasBasis: boolean): string {
  if (!hasBasis) return "—";
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtGrowth(g: GrowthDelta | undefined): {
  label: string;
  color: string;
} {
  if (!g) return { label: "—", color: "var(--pw-fg-muted)" };
  if (g.snapshots < 2) return { label: "—", color: "var(--pw-fg-muted)" };
  if (g.delta === 0) return { label: "0", color: "var(--pw-fg-muted)" };
  const sign = g.delta > 0 ? "+" : "−";
  return {
    label: `${sign}${Math.abs(g.delta).toLocaleString()} (${sign}${Math.abs(
      g.deltaPct,
    ).toFixed(1)}%)`,
    color: g.delta > 0 ? "var(--pw-success)" : "var(--pw-danger)",
  };
}

interface SegmentSelectionControlsProps {
  segments: Segment[];
  selected: string[];
  days: number;
  loading: boolean;
  onToggle: (id: string) => void;
  onDaysChange: (days: number) => void;
  onCompare: () => void;
}

function SegmentSelectionControls({
  segments,
  selected,
  days,
  loading,
  onToggle,
  onDaysChange,
  onCompare,
}: SegmentSelectionControlsProps): ReactElement {
  return (
    <>
      <div
        role="group"
        aria-label="Segments to compare"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          margin: "10px 0",
        }}
      >
        {segments.map((segment) => {
          const checked = selected.includes(segment.id);
          const atCap = !checked && selected.length >= MAX_SEGMENTS;
          return (
            <label
              key={segment.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                opacity: atCap ? 0.5 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={loading || atCap}
                onChange={() => onToggle(segment.id)}
              />
              {segment.name}
            </label>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          role="group"
          aria-label="Comparison window"
          style={{ display: "flex", gap: 6 }}
        >
          {DAY_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              className={`btn btn-sm ${days === choice ? "btn-primary" : "btn-ghost"}`}
              onClick={() => onDaysChange(choice)}
              disabled={loading}
              aria-pressed={days === choice}
            >
              {choice}d
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={onCompare}
          disabled={selected.length < 2 || loading}
        >
          {loading ? "Comparing…" : "Compare"}
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          {selected.length}/{MAX_SEGMENTS} selected
        </span>
      </div>
    </>
  );
}

export function SegmentPerformanceComparison({
  segments,
  onClose,
}: {
  segments: Segment[];
  onClose: () => void;
}): ReactElement {
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState<number>(90);
  const [rows, setRows] = useState<Map<string, PerfRow> | null>(null);
  const [ordered, setOrdered] = useState<string[]>([]);
  const [comparedDays, setComparedDays] = useState<number>(90);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string): void => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_SEGMENTS) return prev;
      return [...prev, id];
    });
  };

  const run = async (): Promise<void> => {
    if (selected.length < 2) return;
    setLoading(true);
    setErr(null);
    const ids = [...selected];
    const requestDays = days;

    // P&L compare in one call; engagement + growth per segment in
    // parallel. A single failing call degrades that cell to "—" rather
    // than blanking the whole comparison.
    const [pnlRes, ...rest] = await Promise.all([
      segmentPnlClient.compare(ids, { days: requestDays }),
      ...ids.flatMap((id) => [
        segmentPnlClient.engagementSummary(id, { days: requestDays }),
        segmentInsightsApi.growth(id, { days: requestDays }),
      ]),
    ]);
    setLoading(false);

    if (pnlRes.error) {
      setErr(pnlRes.error.message);
      setRows(null);
      return;
    }

    const map = new Map<string, PerfRow>();
    for (const id of ids) map.set(id, {});
    for (const it of pnlRes.data?.items ?? []) {
      const row = map.get(it.segment_id) ?? {};
      row.pnl = it;
      map.set(it.segment_id, row);
    }
    // rest is [eng(id0), growth(id0), eng(id1), growth(id1), ...].
    ids.forEach((id, i) => {
      const engRes = rest[i * 2] as Awaited<
        ReturnType<typeof segmentPnlClient.engagementSummary>
      >;
      const growthRes = rest[i * 2 + 1] as Awaited<
        ReturnType<typeof segmentInsightsApi.growth>
      >;
      const row = map.get(id) ?? {};
      if (!engRes.error) row.engagement = engRes.data;
      if (!growthRes.error) {
        row.growth = {
          delta: growthRes.data.delta,
          deltaPct: growthRes.data.delta_pct,
          snapshots: growthRes.data.series.length,
        };
      }
      map.set(id, row);
    });

    setRows(map);
    setOrdered(ids);
    setComparedDays(requestDays);
  };

  const nameFor = (id: string): string =>
    segments.find((s) => s.id === id)?.name ?? id;
  const requestClose = (): void => {
    if (!loading) onClose();
  };

  return (
    <Modal
      open
      onClose={requestClose}
      title="Audience performance comparison"
      description={PERFORMANCE_DESCRIPTION}
      size="xl"
      closeOnBackdrop={!loading}
      closeOnEscape={!loading}
      closeDisabled={loading}
    >
      <div aria-busy={loading ? "true" : undefined}>
        <SegmentSelectionControls
          segments={segments}
          selected={selected}
          days={days}
          loading={loading}
          onToggle={toggle}
          onDaysChange={setDays}
          onCompare={() => void run()}
        />

        {err ? (
          <p role="alert" style={{ fontSize: 13, color: "var(--pw-danger)" }}>
            Compare failed: {err}
          </p>
        ) : null}

        {rows && ordered.length > 0 ? (
          <div style={{ overflowX: "auto", marginTop: 16 }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr>
                  <th style={cellHead}>Metric</th>
                  {ordered.map((id) => (
                    <th key={id} style={cellHead}>
                      {nameFor(id)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={cellLabel}>Members</td>
                  {ordered.map((id) => {
                    const r = rows.get(id);
                    const mc =
                      r?.pnl?.member_count ?? r?.engagement?.member_count ?? 0;
                    return (
                      <td key={id} style={cell}>
                        <ComputedFrom n={mc} unit="members" />
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td style={cellLabel}>Revenue</td>
                  {ordered.map((id) => {
                    const r = rows.get(id);
                    return (
                      <td key={id} style={cell}>
                        {r?.pnl
                          ? fmtMoneyCents(r.pnl.revenue_cents, r.pnl.currency)
                          : "—"}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td style={cellLabel}>Revenue / recipient</td>
                  {ordered.map((id) => {
                    const r = rows.get(id);
                    return (
                      <td key={id} style={{ ...cell, fontWeight: 700 }}>
                        {r?.pnl && r.pnl.revenue_per_member_cents != null
                          ? fmtMoneyCents(
                              r.pnl.revenue_per_member_cents,
                              r.pnl.currency,
                            )
                          : "—"}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td style={cellLabel}>Open rate</td>
                  {ordered.map((id) => {
                    const e = rows.get(id)?.engagement;
                    return (
                      <td key={id} style={cell}>
                        {fmtRate(e?.open_rate, !!e && e.sends > 0)}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td style={cellLabel}>Click rate</td>
                  {ordered.map((id) => {
                    const e = rows.get(id)?.engagement;
                    return (
                      <td key={id} style={cell}>
                        {fmtRate(e?.click_rate, !!e && e.sends > 0)}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td style={cellLabel}>Unsub rate</td>
                  {ordered.map((id) => {
                    const e = rows.get(id)?.engagement;
                    return (
                      <td key={id} style={cell}>
                        {fmtRate(e?.unsub_rate, !!e && e.sends > 0)}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td style={cellLabel}>Growth ({comparedDays}d)</td>
                  {ordered.map((id) => {
                    const g = fmtGrowth(rows.get(id)?.growth);
                    return (
                      <td
                        key={id}
                        style={{ ...cell, color: g.color }}
                        className="tabular"
                      >
                        {g.label}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              Open / click / unsub rates are computed over delivery-outcome
              events for members in the window; segments with no such events in
              the window show &quot;—&quot;. Growth compares the newest vs
              oldest membership snapshot and reads &quot;—&quot; below two
              snapshots.
            </p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

const cellHead: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "2px solid var(--pw-border)",
  whiteSpace: "nowrap",
};
const cell: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--pw-border)",
};
const cellLabel: React.CSSProperties = {
  ...cell,
  fontWeight: 600,
  color: "var(--pw-fg-muted)",
};
