/**
 * SegmentsList — paginated table view of saved segments.
 *
 * The parent Segments page owns data loading + modals; this component
 * is purely presentational. Layout follows the Lists.tsx grid pattern
 * (CSS grid columns string + `.list-row` rows) so the visual rhythm
 * matches the surrounding audience surfaces.
 */

import { type ReactElement } from "react";

import { fmtDate } from "../../lib/format-date";
import { type Segment } from "./segmentsClient";

interface Props {
  rows: Segment[];
  onOpen: (s: Segment) => void;
}

// 6 columns: name · type · members · created · updated · actions
const COLS = "1.6fr 130px 110px 110px 110px 96px";

function kindOf(s: Segment): "dynamic" | "static" | "ai" {
  return s.kind ?? "dynamic";
}

function kindBadge(s: Segment): ReactElement {
  const k = kindOf(s);
  if (k === "static") return <span className="badge">Static</span>;
  if (k === "ai") return <span className="badge accent">AI-suggested</span>;
  return <span className="badge success">Dynamic</span>;
}

export function SegmentsList({ rows, onOpen }: Props): ReactElement {
  return (
    <div className="list">
      <div className="list-header" style={{ gridTemplateColumns: COLS }}>
        <div>Name</div>
        <div>Type</div>
        <div>Members</div>
        <div>Created</div>
        <div>Updated</div>
        <div></div>
      </div>
      {rows.map((r, i) => (
        <div
          key={r.id || i}
          className="list-row"
          style={{ gridTemplateColumns: COLS }}
        >
          <div
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontWeight: 500,
            }}
            title={r.name}
          >
            {r.name || <em className="muted">Unnamed segment</em>}
            {r.description ? (
              <div
                className="muted"
                style={{
                  fontSize: 11,
                  fontWeight: 400,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={r.description}
              >
                {r.description}
              </div>
            ) : null}
          </div>
          <div>{kindBadge(r)}</div>
          <div className="muted tabular">
            {typeof r.lastCount === "number"
              ? r.lastCount.toLocaleString()
              : "—"}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {r.createdAt ? fmtDate(r.createdAt) : "—"}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {r.lastEvaluatedAt
              ? fmtDate(r.lastEvaluatedAt)
              : r.updatedAt
                ? fmtDate(r.updatedAt)
                : "—"}
          </div>
          <div
            style={{ textAlign: "right" }}
          >
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onOpen(r)}
            >
              Open
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
