/**
 * TemplateLeaderboardSection — collapsible "Performance" section on the
 * Templates page, backed by analyticsExtrasApi.templateLeaderboard
 * (apps/api/internal/analytics/template_leaderboard.go).
 *
 * Chrome mirrors the Analytics page's collapsible scheduled-reports
 * card (aria-expanded header button with the rotating caret). Data
 * loads lazily on first expand — the leaderboard runs an events scan
 * server-side, so collapsed visits shouldn't pay for it — and
 * refetches when the window toggle (30d / 90d) changes.
 *
 * Honest-UI notes:
 *   - open_rate / click_rate arrive as 0..1 fractions and are
 *     multiplied by 100 exactly once, in formatLeaderboardRate
 *     (branch rate convention);
 *   - the empty state explains that "no attributable sends" is an
 *     attribution statement, not proof templates are unused — the
 *     muted caveat (LEADERBOARD_ATTRIBUTION_CAVEAT) distinguishes canonical
 *     source lineage from the bounded legacy fallback;
 *   - errors render the verbatim message with a retry button.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type TemplateLeaderboardItem,
  analyticsExtrasApi,
} from "../../lib/api-client";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import {
  LEADERBOARD_ATTRIBUTION_CAVEAT,
  LEADERBOARD_WINDOWS,
  type LeaderboardWindow,
  decodeTemplateLeaderboard,
  formatLeaderboardCount,
  formatLeaderboardRate,
  leaderboardEmptyCopy,
} from "./template-leaderboard";

export function TemplateLeaderboardSection(): ReactElement {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<LeaderboardWindow>(30);
  const [rows, setRows] = useState<TemplateLeaderboardItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadedDays, setLoadedDays] = useState<LeaderboardWindow | null>(null);
  // Stale-response guard: a fast 30d→90d toggle fires two fetches; only
  // the latest may write state (same token idiom as EmailPreviewTabs).
  const reqIdRef = useRef(0);

  const load = useCallback(async (window: LeaderboardWindow): Promise<void> => {
    const myId = ++reqIdRef.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await analyticsExtrasApi.templateLeaderboard({
        days: window,
      });
      if (myId !== reqIdRef.current) return;
      if (res.error) setErr(res.error.message);
      else {
        const verified = decodeTemplateLeaderboard(res.data);
        if (!verified) {
          setRows(null);
          setLoadedDays(null);
          setErr(
            "Moosewave received an invalid template-performance response. Refresh before relying on these results.",
          );
          return;
        }
        setRows(verified);
        setLoadedDays(window);
      }
    } catch {
      if (myId === reqIdRef.current) {
        setErr("Moosewave couldn't load the template leaderboard.");
      }
    } finally {
      if (myId === reqIdRef.current) setLoading(false);
    }
  }, []);

  // Lazy: fetch on first expand, then on window changes while open.
  useEffect(() => {
    if (!open) return;
    void load(days);
  }, [open, days, load]);

  useEffect(
    () => () => {
      reqIdRef.current += 1;
    },
    [],
  );

  const scopedRows = loadedDays === days ? rows : null;
  const columns: readonly DataTableColumn<TemplateLeaderboardItem>[] = [
    {
      id: "template",
      header: "Template",
      width: "280px",
      cell: (row) => (
        <span className="pw-table-truncate">{row.template_name}</span>
      ),
    },
    {
      id: "campaigns",
      header: "Campaigns",
      width: "120px",
      align: "end",
      className: "tabular",
      cell: (row) => formatLeaderboardCount(row.campaigns_used),
    },
    {
      id: "sent",
      header: "Sent",
      width: "100px",
      align: "end",
      className: "tabular",
      cell: (row) => formatLeaderboardCount(row.sent),
    },
    {
      id: "open-rate",
      header: "Open rate",
      width: "120px",
      align: "end",
      cell: (row) => (
        <span className="tpl-leaderboard-metric">
          <strong className="tabular">
            {formatLeaderboardRate(row.open_rate)}
          </strong>
          <span className="muted tabular">
            {formatLeaderboardCount(row.opens)} opens
          </span>
        </span>
      ),
    },
    {
      id: "click-rate",
      header: "Click rate",
      width: "120px",
      align: "end",
      cell: (row) => (
        <span className="tpl-leaderboard-metric">
          <strong className="tabular">
            {formatLeaderboardRate(row.click_rate)}
          </strong>
          <span className="muted tabular">
            {formatLeaderboardCount(row.clicks)} clicks
          </span>
        </span>
      ),
    },
  ];

  return (
    <div className="card" style={{ marginTop: 12, padding: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 16px 6px 6px",
        }}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: 1,
            minWidth: 0,
            padding: "6px 10px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            color: "var(--pw-fg)",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-block",
              transition: "transform 120ms ease",
              transform: open ? "rotate(90deg)" : "none",
              fontSize: 11,
              color: "var(--pw-fg-muted)",
            }}
          >
            ▶
          </span>
          <span className="section-title" style={{ marginBottom: 0 }}>
            Performance
          </span>
          <span className="muted" style={{ fontSize: 11 }}>
            Which templates earn opens and clicks, ranked by sends
          </span>
        </button>
        {open ? (
          <div
            className="chips"
            role="group"
            aria-label="Leaderboard window"
            style={{ gap: 4 }}
          >
            {LEADERBOARD_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                className={`chip${days === w ? " is-active" : ""}`}
                aria-pressed={days === w}
                disabled={loading && days === w}
                onClick={() => {
                  setErr(null);
                  setDays(w);
                }}
              >
                {w}d
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {open ? (
        <div style={{ padding: "0 16px 16px" }}>
          {err ? (
            <div className="notice" role="alert">
              <span>Couldn&apos;t load the template leaderboard: {err}</span>
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-sm"
                disabled={loading}
                onClick={() => void load(days)}
              >
                {loading ? "Retrying…" : "Retry"}
              </button>
            </div>
          ) : null}
          <DataTable
            caption="Template performance leaderboard"
            description={
              loading && scopedRows
                ? `Refreshing ${days}d performance · showing the last verified rows`
                : `Templates ranked by attributable sends · last ${days} days`
            }
            columns={columns}
            rows={scopedRows ?? []}
            getRowKey={(row) => row.template_id}
            loading={scopedRows === null && !err}
            loadingLabel="Loading template performance…"
            emptyState={
              err
                ? "Template performance is unavailable for this window. Retry to load it."
                : leaderboardEmptyCopy(days)
            }
            density="compact"
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            {LEADERBOARD_ATTRIBUTION_CAVEAT}
          </div>
        </div>
      ) : null}
    </div>
  );
}
