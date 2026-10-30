/**
 * RecentFiresPanel — in-memory log of the last N test fires from this
 * session. Playground fires aren't persisted in the delivery table on
 * the server side, so this is purely a session-local history (resets
 * on reload).
 *
 * The operator can click an entry to "load it back" — useful when
 * they want to fire the same payload again after tweaking their
 * receiver, or replay a request that surfaced an unexpected response.
 */

import type { ReactElement } from "react";

export interface RecentFire {
  id: string;
  fire_id?: string;
  delivery_id?: string;
  outcome?: "filtered" | "receiver_responded" | "transport_ambiguous";
  webhook_url?: string;
  event_type: string;
  status_code: number;
  latency_ms: number;
  error: boolean;
  filtered: boolean;
  fired_at: number; // ms epoch
  payload: string; // raw JSON the operator submitted
  webhook_id: string;
}

interface Props {
  fires: RecentFire[];
  onApply: (fire: RecentFire) => void;
  onClear: () => void;
  disabled?: boolean;
}

function statusColor(s: number, err: boolean, filtered: boolean): string {
  if (err || s >= 500) return "var(--pw-danger)";
  if (s >= 400) return "var(--pw-warning)";
  if (filtered) return "var(--pw-fg-muted)";
  if (s >= 200 && s < 300) return "var(--pw-success)";
  return "var(--pw-fg-muted)";
}

function fmtAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3600_000)}h ago`;
}

export function RecentFiresPanel({
  fires,
  onApply,
  onClear,
  disabled = false,
}: Props): ReactElement {
  return (
    <div
      className="card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="section-title" style={{ flex: 1, marginBottom: 0 }}>
          Recent fires
        </div>
        {fires.length > 0 ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onClear}
            disabled={disabled}
            aria-label="Clear recent in-session webhook fires"
          >
            Clear
          </button>
        ) : null}
      </div>

      {fires.length === 0 ? (
        <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
          Fires you trigger this session appear here. Click to re-load the
          payload + event into the editor.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {fires.map((f) => {
            const color = statusColor(f.status_code, f.error, f.filtered);
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onApply(f)}
                disabled={disabled}
                title={`${f.webhook_url ?? f.webhook_id} · ${new Date(f.fired_at).toLocaleString()} · ${f.latency_ms} ms · fire ${f.fire_id ?? f.id}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "8px 1fr 50px 60px",
                  gap: 8,
                  alignItems: "center",
                  background: "var(--pw-bg-elev-2)",
                  border: "none",
                  borderRadius: 4,
                  padding: "6px 10px",
                  minHeight: 48,
                  cursor: "pointer",
                  color: "var(--pw-fg)",
                  textAlign: "left",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: color,
                  }}
                />
                <span
                  style={{
                    fontSize: 11,
                    fontFamily:
                      "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {f.event_type}
                  <span
                    className="muted"
                    style={{ display: "block", fontSize: 9 }}
                  >
                    {f.latency_ms} ms ·{" "}
                    {f.fire_id?.slice(0, 8) ?? f.id.slice(0, 8)}
                  </span>
                </span>
                <span
                  className="tabular"
                  style={{ fontSize: 11, color, textAlign: "right" }}
                >
                  {f.error ? "ERR" : f.filtered ? "FILTERED" : f.status_code}
                </span>
                <span
                  className="tabular muted"
                  style={{ fontSize: 10, textAlign: "right" }}
                >
                  {fmtAgo(f.fired_at)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
