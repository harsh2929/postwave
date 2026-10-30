/**
 * SuppressionTab — list-scoped suppression preview + navigation into
 * the main Suppressions page.
 *
 * Wave-2 (GAP-LS-143): backed by the real per-list endpoint
 * (GET /api/v1/lists/{id}/suppressions via
 * `listsExtendedApi.suppressions`). We render the first page as a
 * preview plus the server's true total in the CTA; full search, bulk
 * add, reason editing, and import / export live in the dedicated
 * Suppressions section. Rows carry no id on the wire — they're keyed
 * by `email` (unique per list).
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type List,
  type ListSuppressionRow,
  listsExtendedApi,
} from "../../../lib/api-client";
import { setSection } from "../../../lib/store";
import { fmtDate } from "../../../lib/format-date";

interface Props {
  list: List;
}

const PREVIEW = 10;

export function SuppressionTab({ list }: Props): ReactElement {
  const [rows, setRows] = useState<ListSuppressionRow[]>([]);
  /** Server-reported total for this list across all pages. */
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await listsExtendedApi.suppressions(list.id, {
        page: 1,
        perPage: PREVIEW,
      });
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message);
        setRows([]);
        setTotal(0);
      } else {
        setRows(res.data?.items ?? []);
        setTotal(res.data?.total ?? 0);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [list.id]);

  const openInSuppressionsPage = (): void => {
    // Older builds wrote list IDs/names into orphan sessionStorage handoff
    // keys. No Suppressions consumer ever read them, so navigation is direct
    // and leaves no customer metadata behind on a shared device.
    setSection("suppressions");
  };

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
          Emails suppressed for this list. Search, bulk add, and import / export
          live in the dedicated Suppressions section.
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm"
          onClick={openInSuppressionsPage}
        >
          Open in Suppressions →
        </button>
      </div>

      {err ? (
        <div className="notice">
          <span>Couldn&apos;t load suppressions: {err}</span>
        </div>
      ) : null}

      {loading ? (
        <>
          <div className="skel-row" />
          <div className="skel-row" />
        </>
      ) : rows.length === 0 ? (
        <div className="pw-chart-empty">
          No suppressions recorded for this list. Bounces, complaints, and
          manual blocks will appear here as they happen.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {rows.map((r) => (
            <div
              key={r.email}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 100px 90px",
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
                title={r.email}
              >
                {r.email}
              </span>
              <span
                className="muted"
                style={{ fontSize: 11, textAlign: "right" }}
                title={r.reason}
              >
                {r.reason || "—"}
              </span>
              <span
                className="muted tabular"
                style={{ fontSize: 10, textAlign: "right" }}
              >
                {r.suppressed_at || r.created_at
                  ? fmtDate(r.suppressed_at || r.created_at)
                  : "—"}
              </span>
            </div>
          ))}
          {total > rows.length ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={openInSuppressionsPage}
              style={{ marginTop: 4 }}
            >
              {/* `rows` is only the first page — `total` is the
               *  server-reported count for this list. */}
              View all {total.toLocaleString()} →
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
