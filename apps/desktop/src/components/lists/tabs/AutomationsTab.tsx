/**
 * AutomationsTab — sequences / automations gated on membership of
 * this list.
 *
 * Wave-2 (GAP-LS-128). Read-only — the actual sequence editor lives
 * in the Sequences section. Per row we show name, status (active /
 * paused / draft), trigger type and enrolled count.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type List,
  type ListAutomationSummary,
  listsAutomationsApi,
} from "../../../lib/api-client";
import { setSection } from "../../../lib/store";
import { fmtDate } from "../../../lib/format-date";

interface Props {
  list: List;
}

function statusBadge(status: string | undefined): ReactElement {
  const s = (status ?? "").toLowerCase();
  if (s === "active" || s === "running")
    return <span className="badge success">{status}</span>;
  if (s === "paused") return <span className="badge warning">{status}</span>;
  if (s === "draft") return <span className="badge">{status}</span>;
  if (s === "archived")
    return <span className="badge">{status}</span>;
  return <span className="badge">{status ?? "—"}</span>;
}

export function AutomationsTab({ list }: Props): ReactElement {
  const [rows, setRows] = useState<ListAutomationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await listsAutomationsApi.list(list.id);
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message);
        setRows([]);
      } else {
        setRows(res.data?.items ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [list.id]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div className="muted" style={{ fontSize: 12 }}>
          Automations triggered by, or gated on, members of{" "}
          <code>{list.name}</code>.
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setSection("sequences")}
        >
          Manage automations →
        </button>
      </div>

      {err ? (
        <div className="notice">
          <span>Couldn&apos;t load automations: {err}</span>
        </div>
      ) : null}

      {loading ? (
        <>
          <div className="skel-row" />
          <div className="skel-row" />
        </>
      ) : rows.length === 0 ? (
        <div className="pw-chart-empty">
          No automations are gated on this list yet. Create a sequence and
          add a list-membership trigger to wire one up.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 90px 110px 80px 90px",
              gap: 8,
              padding: "4px 10px",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              color: "var(--pw-fg-subtle)",
            }}
          >
            <span>Automation</span>
            <span>Status</span>
            <span>Trigger</span>
            <span style={{ textAlign: "right" }}>Enrolled</span>
            <span style={{ textAlign: "right" }}>Created</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 90px 110px 80px 90px",
                gap: 8,
                alignItems: "center",
                padding: "6px 10px",
                background: "var(--pw-bg-elev-2)",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: "var(--pw-fg)",
                }}
                title={r.name}
              >
                {r.name}
              </span>
              <span>{statusBadge(r.status)}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                {r.trigger_type ?? "—"}
              </span>
              <span
                className="tabular"
                style={{ fontSize: 11, textAlign: "right" }}
              >
                {(r.enrolled_count ?? 0).toLocaleString()}
              </span>
              <span
                className="muted tabular"
                style={{ fontSize: 10, textAlign: "right" }}
              >
                {r.created_at ? fmtDate(r.created_at) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
