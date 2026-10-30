/**
 * ConsentProofPanel — surfaces recent consent_records and a per-source
 * count breakdown. GAP-LS-096 / 097. The portal summary already gives
 * us per-source counts; we render those plus a link out to the
 * tenant-wide Consent receipts ledger for the deep dive.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type ConsentReceipt,
  type PrivacyPortalConsentProofSummary,
  api,
} from "../../lib/api-client";
import { useMe } from "../../lib/store";

interface Props {
  summary: PrivacyPortalConsentProofSummary[];
}

const RECENT_LIMIT = 8;

function fmtRel(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (Math.abs(diffSec) < 60) return `${diffSec}s ago`;
  if (Math.abs(diffSec) < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (Math.abs(diffSec) < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (Math.abs(diffSec) < 86400 * 7)
    return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ConsentProofPanel({ summary }: Props): ReactElement {
  const me = useMe();
  const canReadRecentEvidence = me?.effectiveRole === "admin";
  const [recent, setRecent] = useState<ConsentReceipt[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const workspaceId = me?.tenant;
    setRecent(null);
    setErr(null);
    if (!workspaceId || !canReadRecentEvidence) return;
    let cancelled = false;
    void (async () => {
      const res = await api.listConsentReceipts({
        workspaceId,
        limit: RECENT_LIMIT,
      });
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message);
        setRecent([]);
        return;
      }
      setRecent(res.data?.receipts ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [canReadRecentEvidence, me?.tenant, me?.user]);

  const totalByCount = summary.reduce((s, r) => s + r.count, 0);

  return (
    <section
      className="card"
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}
    >
      <header>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Consent proof</div>
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          Source-reported consent proof summary. {totalByCount.toLocaleString()}{" "}
          records are represented by the loaded summary; this is not a certified
          export.
        </div>
      </header>

      {summary.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No consent-proof summary rows were returned in this loaded response.
          This does not establish that no consent evidence exists in another
          source plane.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 8,
          }}
        >
          {summary.map((s) => (
            <div
              key={s.source}
              style={{
                border: "1px solid var(--pw-border)",
                borderRadius: 6,
                padding: "8px 10px",
                background: "var(--pw-bg-elev-2)",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  color: "var(--pw-fg-muted)",
                }}
              >
                {s.source || "unknown"}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
                {s.count.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "var(--pw-fg-muted)",
            marginBottom: 6,
          }}
        >
          Recent receipts
        </div>
        {!canReadRecentEvidence ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Recent receipt evidence is available only to workspace admins.
          </div>
        ) : recent === null ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Loading…
          </div>
        ) : err ? (
          <div className="muted" style={{ fontSize: 12 }}>
            {err}
          </div>
        ) : recent.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No receipt or proof rows were returned in this loaded page.
          </div>
        ) : (
          <div className="list">
            {recent.map((r) => {
              const isGranted =
                r.new_state === "granted" || r.new_state === "subscribed";
              return (
                <div
                  key={`${r.kind}:${r.id}`}
                  className="list-row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.6fr 110px 90px 110px",
                    alignItems: "center",
                    padding: "6px 10px",
                    gap: 10,
                    fontSize: 12,
                  }}
                >
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.subscriber_email}
                  </div>
                  <div>{r.source || "—"}</div>
                  <div>
                    <span
                      className={`badge${isGranted ? " success" : " warning"}`}
                    >
                      {r.new_state}
                    </span>
                  </div>
                  <div className="muted">{fmtRel(r.at)}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
