/**
 * WhyHighRiskModal — explains the UEBA anomaly score that flagged
 * this row as high-risk. ueba-baselines (AI/Anomaly, P1).
 *
 * Renders:
 *   - the aggregate score + bucket
 *   - per-detector reasons with confidence
 *   - the actor's baseline snapshot (typical hours / IPs / actions /
 *     mean activity) for the operator to compare against the
 *     flagged row
 *   - MITRE ATT&CK technique tags with external links to attack.mitre.org
 *
 * Loads lazily on open so a row whose modal never opens doesn't
 * incur a network call.
 */

import { useEffect, useState, type ReactElement } from "react";

import {
  api,
  type AnomalyScoreResponse,
  type AuditRow,
} from "../../lib/api-client";

import { Modal } from "../Modal";
import { ExternalLink } from "../ExternalLink";

interface Props {
  row: AuditRow;
  onClose: () => void;
}

function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function mitreLink(id: string): string {
  // Sub-technique IDs use a dot (T1078.001) — attack.mitre.org URL
  // converts the dot to a slash. Whole-technique IDs keep the path.
  const path = id.includes(".") ? id.replace(".", "/") : id;
  return `https://attack.mitre.org/techniques/${path}/`;
}

export function WhyHighRiskModal({ row, onClose }: Props): ReactElement {
  const [data, setData] = useState<AnomalyScoreResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await api.getAuditAnomalyScore(Number(row.id));
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message ?? "Failed to load anomaly score.");
        setLoading(false);
        return;
      }
      setData(res.data ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  return (
    <Modal
      open
      onClose={onClose}
      title="Why is this high risk?"
      description={`UEBA anomaly detail for audit event ${row.id}.`}
      size="lg"
    >
      {loading ? (
        <div className="muted" style={{ padding: 16 }}>
          Loading anomaly score…
        </div>
      ) : err ? (
        <div
          className="muted"
          style={{ padding: 16, color: "var(--pw-danger)" }}
        >
          {err}
        </div>
      ) : !data || !data.available ? (
        <div className="muted" style={{ padding: 16 }}>
          No UEBA anomaly recorded for this event. The risk badge you may be
          seeing on the row comes from the client-side rule fallback
          (destructive verb / large export / off-hours).
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Score header */}
          <div
            className="row"
            style={{
              gap: 16,
              alignItems: "center",
              padding: 12,
              background: "var(--pw-bg-elev-2)",
              borderRadius: 6,
            }}
          >
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                Aggregate score
              </div>
              <div
                className="tabular"
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color:
                    data.bucket === "high"
                      ? "var(--pw-danger)"
                      : data.bucket === "med"
                        ? "var(--pw-advisor)"
                        : "var(--pw-fg-muted)",
                }}
              >
                {Math.round(data.score)}
                <span
                  className="muted"
                  style={{ fontSize: 14, fontWeight: 400 }}
                >
                  {" "}
                  / 100
                </span>
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                Risk bucket
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  textTransform: "uppercase",
                }}
              >
                {data.bucket}
              </div>
            </div>
          </div>

          {/* Detector reasons */}
          <div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
              Detector reasons
            </div>
            {data.reasons.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>
                No detector fired — this row may have been hand-flagged.
              </div>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {data.reasons.map((r, i) => (
                  <li
                    key={`${r.type}-${i}`}
                    style={{
                      padding: 8,
                      border: "1px solid var(--pw-border)",
                      borderRadius: 4,
                    }}
                  >
                    <div
                      className="row"
                      style={{ gap: 8, alignItems: "center" }}
                    >
                      <code style={{ fontSize: 11, fontWeight: 600 }}>
                        {r.type}
                      </code>
                      <span className="muted tabular" style={{ fontSize: 11 }}>
                        confidence {fmtPct(r.confidence)}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>{r.reason}</div>
                    {r.mitre && r.mitre.length > 0 ? (
                      <div className="row" style={{ gap: 4, marginTop: 6 }}>
                        {r.mitre.map((m) => (
                          <ExternalLink
                            key={m}
                            href={mitreLink(m)}
                            className="audit-mitre-tag"
                            style={{
                              fontSize: 10,
                              padding: "2px 6px",
                              border: "1px solid var(--pw-border)",
                              borderRadius: 3,
                              textDecoration: "none",
                            }}
                            title={`MITRE ATT&CK ${m} — opens attack.mitre.org`}
                          >
                            ATT&CK {m}
                          </ExternalLink>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Baseline snapshot */}
          {data.baseline ? (
            <div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
                Actor baseline ({data.baseline.day})
              </div>
              <div
                className="row"
                style={{ gap: 24, fontSize: 12, flexWrap: "wrap" }}
              >
                <div>
                  <div className="muted">Typical hours (UTC)</div>
                  <div className="mono tabular">
                    {Object.entries(data.baseline.typicalHours)
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .slice(0, 6)
                      .map(([h, c]) => `${h}h×${c}`)
                      .join("  ") || "—"}
                  </div>
                </div>
                <div>
                  <div className="muted">Typical /16 networks</div>
                  <div className="mono">
                    {data.baseline.typicalIps.length > 0
                      ? data.baseline.typicalIps.map((p) => `${p}.*`).join("  ")
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="muted">Mean actions/day</div>
                  <div className="tabular">
                    {data.baseline.meanActionsPerDay.toFixed(1)}
                  </div>
                </div>
                <div>
                  <div className="muted">Top historical actions</div>
                  <div className="mono">
                    {Object.entries(data.baseline.typicalActions)
                      .sort(([, a], [, b]) => b - a)
                      .slice(0, 3)
                      .map(([a, c]) => `${a}×${c}`)
                      .join("  ") || "—"}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>
              No baseline available yet (cold-start window — the UEBA worker
              computes baselines after the first 24h of activity).
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
