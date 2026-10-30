/**
 * SegmentCompareView — side-by-side P&L comparison of 2–5 segments
 * (feature #4, approved decision D5: a MODAL/slideover, NOT a new route,
 * to avoid touching App.tsx / Sidebar.tsx / CommandPalette.tsx on the
 * shared branch).
 *
 * The user picks 2–5 segments; we fetch GET /api/v1/segments/pnl/compare
 * and render one column per segment with the economic rows. The
 * net-contribution-per-member row leads and is colour-coded; the highest
 * non-null column gets a "Winner" badge (via compareRank, which sorts
 * nulls last and never crowns a figure we don't have).
 *
 * Honest-UI: per-column ComputedFrom shows the member count used; the
 * compare focuses on observed/cost pillars (lift lives in the per-segment
 * slideover). Cross-currency / no-cost-config columns format net as "not
 * available" rather than a fabricated number.
 */

import { type ReactElement, useState } from "react";

import { ComputedFrom, EstimateBadge } from "../common/Provenance";
import { Modal } from "../Modal";
import {
  compareRank,
  fmtMoneyCents,
  fmtNetContribution,
} from "../../lib/segment-pnl-helpers";
import type { Segment } from "./segmentsClient";
import { type SegmentPnLResponse, segmentPnlClient } from "./segmentPnlClient";

const DAY_CHOICES = [30, 90, 365] as const;
const MAX_SEGMENTS = 5;
const COMPARE_DESCRIPTION =
  "Compare two to five segments across net contribution per member, revenue, average order value, costs, and audience outcomes.";

export function SegmentCompareView({
  segments,
  onClose,
}: {
  segments: Segment[];
  onClose: () => void;
}): ReactElement {
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState<number>(90);
  const [items, setItems] = useState<SegmentPnLResponse[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string): void => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_SEGMENTS) return prev; // cap at 5
      return [...prev, id];
    });
  };

  const run = async (): Promise<void> => {
    if (selected.length < 2) return;
    setLoading(true);
    setErr(null);
    const res = await segmentPnlClient.compare(selected, { days });
    setLoading(false);
    if (res.error) {
      setErr(res.error.message);
      setItems(null);
      return;
    }
    setItems(res.data?.items ?? []);
  };

  const nameFor = (id: string): string =>
    segments.find((s) => s.id === id)?.name ?? id;

  const ranked = items
    ? compareRank(
        items.map((it) => ({
          segment_id: it.segment_id,
          member_count: it.member_count,
          net_contribution_per_member_cents:
            it.net_contribution_per_member_cents ?? null,
        })),
      )
    : [];
  const rankById = new Map(ranked.map((r) => [r.segment_id, r]));
  const requestClose = (): void => {
    if (!loading) onClose();
  };

  return (
    <Modal
      open
      onClose={requestClose}
      title="Compare segment P&L"
      description={COMPARE_DESCRIPTION}
      size="xl"
      closeOnBackdrop={!loading}
      closeOnEscape={!loading}
      closeDisabled={loading}
    >
      <div aria-busy={loading ? "true" : undefined}>
        {/* Selector. */}
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
          {segments.map((s) => {
            const on = selected.includes(s.id);
            const atCap = !on && selected.length >= MAX_SEGMENTS;
            return (
              <label
                key={s.id}
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
                  checked={on}
                  disabled={loading || atCap}
                  onChange={() => toggle(s.id)}
                />
                {s.name}
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
            {DAY_CHOICES.map((d) => (
              <button
                key={d}
                type="button"
                className={`btn btn-sm ${days === d ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setDays(d)}
                disabled={loading}
                aria-pressed={days === d}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void run()}
            disabled={selected.length < 2 || loading}
          >
            {loading ? "Comparing…" : "Compare"}
          </button>
          <span className="muted" style={{ fontSize: 11 }}>
            {selected.length}/{MAX_SEGMENTS} selected
          </span>
        </div>

        {err ? (
          <p role="alert" style={{ fontSize: 13, color: "var(--pw-danger)" }}>
            Compare failed: {err}
          </p>
        ) : null}

        {/* Comparison table. */}
        {items && items.length > 0 ? (
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
                  {items.map((it) => {
                    const r = rankById.get(it.segment_id);
                    return (
                      <th key={it.segment_id} style={cellHead}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          {nameFor(it.segment_id)}
                          {r?.isWinner ? (
                            <span
                              className="badge success"
                              title="Highest net contribution per member"
                            >
                              Winner
                            </span>
                          ) : null}
                          {!it.cost_config_present ? (
                            <EstimateBadge
                              label="Est."
                              title="No cost config — net contribution is an estimate."
                            />
                          ) : null}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={cellLabel}>Net / member</td>
                  {items.map((it) => (
                    <td
                      key={it.segment_id}
                      style={{ ...cell, fontWeight: 700 }}
                    >
                      {fmtNetContribution(
                        it.net_contribution_per_member_cents ?? null,
                        it.currency || it.cost_currency,
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td style={cellLabel}>Revenue</td>
                  {items.map((it) => (
                    <td key={it.segment_id} style={cell}>
                      {fmtMoneyCents(it.revenue_cents, it.currency)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td style={cellLabel}>AOV</td>
                  {items.map((it) => (
                    <td key={it.segment_id} style={cell}>
                      {it.aov_cents != null
                        ? fmtMoneyCents(
                            it.aov_cents,
                            it.aov_currency || it.currency,
                          )
                        : "—"}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td style={cellLabel}>Unsubs / complaints</td>
                  {items.map((it) => (
                    <td key={it.segment_id} style={cell}>
                      {it.unsub_count} / {it.complaint_count}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td style={cellLabel}>Members</td>
                  {items.map((it) => (
                    <td key={it.segment_id} style={cell}>
                      <ComputedFrom n={it.member_count} unit="members" />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        ) : items && items.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            No results.
          </p>
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
