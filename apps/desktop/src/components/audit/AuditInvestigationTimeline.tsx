/**
 * AuditInvestigationTimeline — chronological view of every audit row
 * cited as evidence by an investigation.
 *
 * Renders one row per evidence_audit_id, sorted oldest-to-newest, so
 * the investigator can scan the sequence of operations leading up to
 * the seed event.
 *
 * Rows are fetched via the batch lookup endpoint
 * (GET /audit/events?ids=…, ≤100 ids per call — chunked when an
 * investigation cites more). This replaced the old budgeted cursor
 * walk over /audit, which could scan thousands of rows and still
 * stop short of sparse / very old citations.
 */

import { type ReactElement, useEffect, useState } from "react";

import { type AuditRow, api } from "../../lib/api-client";
import { chunkEvidenceIds } from "./evidenceBatch";

interface Props {
  evidenceAuditIds: number[];
  seedAuditId: number;
  onSelect?: (row: AuditRow) => void;
}

export function AuditInvestigationTimeline({
  evidenceAuditIds,
  seedAuditId,
  onSelect,
}: Props): ReactElement {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  // Fetch error from the batch lookup (network/HTTP failure — distinct
  // from "rows genuinely absent from the log").
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const wantedCount = new Set(evidenceAuditIds.map((n) => Number(n))).size;
  const missingCount = Math.max(0, wantedCount - rows.length);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setFetchErr(null);
      if (evidenceAuditIds.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }
      // Batch lookup by id — one call per ≤100-id chunk. A failed
      // chunk surfaces as a fetch error (with whatever rows the other
      // chunks returned still rendered); only a fully-successful fetch
      // that comes up short means the rows are genuinely gone.
      const chunks = chunkEvidenceIds(evidenceAuditIds.map((n) => Number(n)));
      const results = await Promise.all(
        chunks.map((ids) => api.getAuditEventsByIds(ids)),
      );
      if (cancelled) return;
      const found = new Map<number, AuditRow>();
      let fetchError: string | null = null;
      for (const res of results) {
        if (res.error) {
          fetchError = res.error.message;
          continue;
        }
        for (const r of res.data?.items ?? []) {
          found.set(Number(r.id), r);
        }
      }
      const hits = [...found.values()];
      hits.sort(
        (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
      );
      setRows(hits);
      setFetchErr(fetchError);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [evidenceAuditIds, retryNonce]);

  if (loading) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        Loading timeline…
      </div>
    );
  }

  // Honest empty/partial states: a fetch error means we *couldn't
  // load* the rows — only a fully-successful fetch that came up short
  // means the rows are actually gone.
  const statusNotice =
    fetchErr != null ? (
      <div
        role="alert"
        style={{ fontSize: 12, color: "var(--pw-danger)", marginBottom: 8 }}
        data-testid="audit-investigation-timeline-error"
      >
        Couldn&apos;t load {missingCount} of {wantedCount} evidence row
        {wantedCount === 1 ? "" : "s"}: {fetchErr}{" "}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setRetryNonce((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    ) : missingCount > 0 ? (
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {missingCount} of {wantedCount} evidence row
        {wantedCount === 1 ? "" : "s"} {missingCount === 1 ? "is" : "are"} no
        longer in the audit log (retention-trimmed).
      </div>
    ) : null;

  if (rows.length === 0) {
    return (
      statusNotice ?? (
        <div className="muted" style={{ fontSize: 12 }}>
          No evidence rows cited.
        </div>
      )
    );
  }
  return (
    <div>
      {statusNotice}
      <ol
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          borderLeft: "2px solid var(--pw-border-soft)",
          marginLeft: 6,
        }}
        data-testid="audit-investigation-timeline"
      >
        {rows.map((r) => {
          const isSeed = Number(r.id) === seedAuditId;
          return (
            <li
              key={r.id}
              style={{
                position: "relative",
                paddingLeft: 18,
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: -7,
                  top: 4,
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  background: isSeed
                    ? "var(--pw-accent)"
                    : "var(--pw-bg-elev)",
                  border: "2px solid var(--pw-accent)",
                }}
              />
              <button
                type="button"
                disabled={!onSelect}
                onClick={() => onSelect?.(r)}
                aria-label={`Open audit event ${r.action}`}
                style={{
                  display: "block",
                  width: "100%",
                  padding: 0,
                  border: 0,
                  background: "transparent",
                  color: "inherit",
                  textAlign: "left",
                  cursor: onSelect ? "pointer" : "default",
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {new Date(r.at).toLocaleString()}
                  {isSeed ? " · seed" : ""}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {r.action}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {r.actorLabel ?? "—"} · {r.actorType}
                  {r.resourceId ? ` · ${r.resourceId}` : ""}
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
