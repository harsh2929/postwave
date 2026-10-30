/**
 * OverviewTab — health card + description + dates + tags for a single list.
 *
 * Moved out of ListDetailSlideover when GAP-LS-049/050 split the slideover
 * into tabs (Wave-1). The existing HealthCard markup is preserved verbatim
 * so the visual + accessibility behaviour is unchanged.
 */

import { type ReactElement } from "react";

import type { List, ListHealthResult } from "../../../lib/api-client";
import { fmtDateTime } from "../../../lib/format-date";

interface Props {
  list: List;
  health: ListHealthResult | null | undefined;
}

export function OverviewTab({ list, health }: Props): ReactElement {
  const tags = Array.isArray(list.tags) ? list.tags : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <HealthCard health={health} listName={list.name} />

      {list.description ? (
        <div className="card pw-chart-card">
          <div className="pw-chart-head">
            <div className="section-title" style={{ marginBottom: 0 }}>
              Description
            </div>
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--pw-fg)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {list.description}
          </div>
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div className="card pw-chart-card">
          <div className="pw-chart-head">
            <div className="section-title" style={{ marginBottom: 0 }}>
              Tags
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {tags.length} tag{tags.length === 1 ? "" : "s"}
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {tags.map((t) => (
              <span key={t} className="badge">
                {t}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <div className="section-title" style={{ marginBottom: 0 }}>
            Timestamps
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            columnGap: 12,
            rowGap: 4,
            fontSize: 12,
          }}
        >
          <span
            className="muted"
            style={{ textTransform: "uppercase", fontSize: 10, letterSpacing: 0.4 }}
          >
            Created
          </span>
          <span className="tabular">{fmtDateTime(list.created_at)}</span>
          <span
            className="muted"
            style={{ textTransform: "uppercase", fontSize: 10, letterSpacing: 0.4 }}
          >
            Updated
          </span>
          <span className="tabular">{fmtDateTime(list.updated_at)}</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- health card (moved verbatim from ListDetailSlideover) -- */

function HealthCard({
  health,
  listName,
}: {
  health: ListHealthResult | null | undefined;
  listName: string;
}): ReactElement {
  if (health === undefined) {
    return (
      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <div className="section-title" style={{ marginBottom: 0 }}>
            Health
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Computing…
        </div>
      </div>
    );
  }
  if (health === null) {
    return (
      <div className="card pw-chart-card">
        <div className="pw-chart-head">
          <div className="section-title" style={{ marginBottom: 0 }}>
            Health
          </div>
        </div>
        <div className="pw-chart-empty">
          No engagement signal yet for <code>{listName}</code>. Health appears
          once subscribers tagged with this list have received campaigns.
        </div>
      </div>
    );
  }
  const gradeColor =
    health.grade.startsWith("A")
      ? "var(--pw-accent)"
      : health.grade.startsWith("B")
        ? "color-mix(in srgb, var(--pw-accent) 70%, var(--pw-warning))"
        : health.grade.startsWith("C")
          ? "var(--pw-warning)"
          : "var(--pw-danger)";
  return (
    <div className="card pw-chart-card">
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Health
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Last {health.window_days} days
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 14,
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: 72,
            height: 72,
            borderRadius: "50%",
            background: `color-mix(in srgb, ${gradeColor} 14%, transparent)`,
            color: gradeColor,
          }}
        >
          <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1 }}>
            {health.grade}
          </div>
          <div
            className="tabular"
            style={{
              fontSize: 11,
              color: "var(--pw-fg-muted)",
              marginTop: 2,
            }}
          >
            {health.score}/100
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            fontSize: 12,
          }}
        >
          <RateRow label="Engagement" value={health.engagement_rate} positive />
          <RateRow label="Suppression" value={health.suppression_rate} inverted />
          <RateRow label="Bounce" value={health.bounce_rate} inverted />
          <RateRow label="Complaint" value={health.complaint_rate} inverted />
        </div>
      </div>
      {health.notes && health.notes.length > 0 ? (
        <div
          style={{
            marginTop: 10,
            borderTop: "1px solid var(--pw-border)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {health.notes.slice(0, 4).map((n, i) => (
            <div
              key={i}
              style={{
                fontSize: 11,
                color: "var(--pw-fg-muted)",
                lineHeight: 1.5,
              }}
            >
              · {n}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RateRow({
  label,
  value,
  positive,
  inverted,
}: {
  label: string;
  value: number;
  positive?: boolean;
  inverted?: boolean;
}): ReactElement {
  const pct = value * 100;
  const color = positive
    ? "var(--pw-accent)"
    : inverted && pct > 1
      ? "var(--pw-danger)"
      : "var(--pw-fg)";
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      <span
        className="muted"
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {label}
      </span>
      <span
        className="tabular"
        style={{ color, fontSize: 13, fontWeight: 500 }}
      >
        {pct.toFixed(pct >= 10 ? 0 : 2)}%
      </span>
    </div>
  );
}
