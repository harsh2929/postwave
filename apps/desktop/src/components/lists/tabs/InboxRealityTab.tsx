/**
 * InboxRealityTab — per-list seed-test placement history inside the
 * list detail slideover (full-surface wiring #46).
 *
 * Backend: GET /api/v1/lists/{id}/inbox-reality?limit= (search pkg) →
 * `{list_id, items}` where each item is one seed-list placement test:
 * `{test_id, subject?, created_at, status, total_seeds, inbox, spam,
 *   missing, inbox_pct}` (limit capped at 25 server-side).
 *
 * Honesty notes:
 *   - These are seed-inbox placement results (did the mail land in
 *     inbox / spam / nowhere on the seed accounts), not subscriber
 *     open/click engagement — the caption says so.
 *   - Pending tests show "—" instead of a fake 0% (inbox-reality-copy).
 *   - Empty state explains where the data comes from rather than
 *     pretending the feature is broken.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type List,
  type ListInboxRealityRow,
  listsInboxRealityApi,
} from "../../../lib/api-client";
import { fmtDate } from "../../../lib/format-date";
import {
  inboxPctLabel,
  seedSplitLabel,
  statusBadgeClass,
} from "./inbox-reality-copy";

interface Props {
  list: List;
}

const LIMIT = 25; // server cap

export function InboxRealityTab({ list }: Props): ReactElement {
  const [rows, setRows] = useState<ListInboxRealityRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await listsInboxRealityApi.list(list.id, LIMIT);
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message);
        setRows(null);
      } else {
        setRows(res.data?.items ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [list.id, reloadKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
      >
        <div className="muted" style={{ fontSize: 12 }}>
          Seed-inbox placement tests for campaigns sent to this list —
          where the mail actually landed (inbox vs spam) on seed
          accounts. This is placement, not subscriber opens or clicks.
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {err ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load inbox-reality results: {err}</span>
        </div>
      ) : null}

      {loading ? (
        <>
          <div className="skel-row" />
          <div className="skel-row" />
        </>
      ) : !rows || rows.length === 0 ? (
        <div className="pw-chart-empty">
          No seed tests recorded for this list yet. Results appear here
          after a campaign targeting this list runs an inbox-reality seed
          test and the seed accounts report back.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 90px 70px 80px",
              gap: 8,
              padding: "0 10px",
              fontSize: 11,
              color: "var(--pw-fg-subtle)",
            }}
          >
            <span>Test</span>
            <span>Status</span>
            <span style={{ textAlign: "right" }}>Inbox %</span>
            <span style={{ textAlign: "right" }}>Run</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.test_id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 90px 70px 80px",
                gap: 8,
                alignItems: "center",
                padding: "6px 10px",
                background: "var(--pw-bg-elev-2)",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={r.subject || r.test_id}
                >
                  {r.subject || (
                    <span className="muted">Test {r.test_id}</span>
                  )}
                </div>
                <div className="muted tabular" style={{ fontSize: 10 }}>
                  {seedSplitLabel(r)}
                </div>
              </div>
              <span>
                <span className={statusBadgeClass(r.status)}>{r.status}</span>
              </span>
              <span
                className="tabular"
                style={{ textAlign: "right" }}
                title={
                  inboxPctLabel(r) === "—"
                    ? "No seed reports yet — the percentage appears once seeds report."
                    : `${r.inbox.toLocaleString()} of ${r.total_seeds.toLocaleString()} seeds landed in the inbox`
                }
              >
                {inboxPctLabel(r)}
              </span>
              <span
                className="muted tabular"
                style={{ fontSize: 10, textAlign: "right" }}
              >
                {fmtDate(r.created_at)}
              </span>
            </div>
          ))}
          {rows.length === LIMIT ? (
            <div className="muted" style={{ fontSize: 11, padding: "4px 10px" }}>
              Showing the {LIMIT} most recent tests (server limit).
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
