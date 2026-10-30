/**
 * FeedSourcesSection — "Recurring (RSS)" collapsible section on the
 * Campaigns page (R1, apps/api/internal/feed_ingest).
 *
 *   - list sources (lazy: first expand fetches) with name / url /
 *     schedule / enabled / last polled / last run status;
 *   - create + edit via FeedSourceFormModal;
 *   - delete behind ConfirmModal;
 *   - "Poll now" → renders the run result verbatim. A failed poll is
 *     still HTTP 200 with status:"failed" + error text, so the result
 *     panel branches on `status`, never the ApiResult error path. A
 *     successful poll that minted a draft links to it via the parent's
 *     detail-open mechanism (onOpenCampaign);
 *   - per-source runs-history drilldown (GET …/{id}/runs).
 *
 * Honest copy throughout: polls create DRAFT campaigns only — nothing
 * sends automatically. Mutations + polls are write:campaigns
 * server-side → gated on useCanWrite() with viewer tooltips; the
 * server stays the final authority.
 */

import { useEffect, useId, useRef, useState, type ReactElement } from "react";

import {
  feedSourcesApi,
  type FeedIngestRun,
  type FeedPollResult,
  type FeedSource,
} from "../../lib/api-client";
import { useCanWrite } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { InlineHelp } from "../InlineHelp";
import { toast } from "../Toast";
import { FeedSourceFormModal } from "./FeedSourceFormModal";
import {
  FEED_SCHEDULES,
  fmtRunTimestamp,
  lastPolledLabel,
  runStatusBadgeClass,
  runStatusLabel,
  summarizePollResult,
} from "./feed-sources-helpers";

const COLS = "1.6fr 90px 80px 130px 110px 1fr";

/** Latest-run cell state, fetched per source after the list lands. */
type LatestRun =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "run"; run: FeedIngestRun };

interface RunsState {
  loading: boolean;
  err: string | null;
  items: FeedIngestRun[] | null;
}

interface Props {
  /** Detail-open mechanism: the Campaigns page refreshes its list and
   *  opens the matching campaign's detail slideover. */
  onOpenCampaign: (campaignId: string) => void;
}

function LatestRunCell({ latestRun }: { latestRun?: LatestRun }): ReactElement {
  if (!latestRun || latestRun.kind === "loading") {
    return (
      <span className="muted" style={{ fontSize: 12 }} aria-live="polite">
        Loading…
      </span>
    );
  }
  if (latestRun.kind === "none") {
    return (
      <span className="muted" style={{ fontSize: 12 }}>
        No runs
      </span>
    );
  }
  if (latestRun.kind === "unavailable") {
    return (
      <span className="muted" style={{ fontSize: 12 }}>
        Run history unavailable
      </span>
    );
  }
  return (
    <span className={runStatusBadgeClass(latestRun.run.status)}>
      {runStatusLabel(latestRun.run.status)} ·{" "}
      {latestRun.run.error || fmtRunTimestamp(latestRun.run.started_at)}
    </span>
  );
}

interface PollResultPanelProps {
  source: FeedSource;
  result?: FeedPollResult;
  onOpenCampaign: (campaignId: string) => void;
  onDismiss: () => void;
}

function PollResultPanel({
  source,
  result,
  onOpenCampaign,
  onDismiss,
}: PollResultPanelProps): ReactElement | null {
  if (!result) return null;
  const outcome = summarizePollResult(result);
  const color =
    outcome.tone === "bad"
      ? "var(--pw-danger)"
      : outcome.tone === "good"
        ? "var(--pw-accent)"
        : "var(--pw-fg-muted)";
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        borderLeft: `2px solid ${color}`,
        padding: "6px 10px",
        margin: "4px 0 8px",
        fontSize: 12,
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <span className={runStatusBadgeClass(result.status)}>
        {runStatusLabel(result.status)}
      </span>
      <span>{outcome.headline}</span>
      {outcome.detail ? <span className="muted">{outcome.detail}</span> : null}
      {result.status !== "failed" && result.campaign_id ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onOpenCampaign(result.campaign_id!)}
        >
          Open draft campaign
        </button>
      ) : null}
      <span className="spacer" />
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={onDismiss}
        aria-label={`Dismiss poll result for ${source.name}`}
      >
        Dismiss
      </button>
    </div>
  );
}

interface RunsDrilldownProps {
  source: FeedSource;
  runs: RunsState;
  onRetry: () => void;
  onOpenCampaign: (campaignId: string) => void;
}

function RunsDrilldown({
  source,
  runs,
  onRetry,
  onOpenCampaign,
}: RunsDrilldownProps): ReactElement {
  return (
    <div
      id={`feed-source-runs-${source.id}`}
      style={{
        padding: "8px 12px 12px",
        borderBottom: "1px solid var(--pw-border)",
      }}
    >
      <div className="label">Run history — {source.name}</div>
      {runs.loading ? (
        <div
          className="skel"
          style={{ height: 32 }}
          role="status"
          aria-label={`Loading run history for ${source.name}`}
        />
      ) : runs.err ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load runs: {runs.err}</span>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : runs.items != null && runs.items.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No runs yet — Poll now to run the first one.
        </div>
      ) : runs.items != null ? (
        <table className="link-table" style={{ width: "100%" }}>
          <tbody>
            {runs.items.map((run) => (
              <tr key={run.id}>
                <td>
                  <span className={runStatusBadgeClass(run.status)}>
                    {runStatusLabel(run.status)}
                  </span>
                </td>
                <td className="tabular muted" style={{ fontSize: 12 }}>
                  {run.new_items} new / {run.items_seen} seen
                </td>
                <td className="tabular muted" style={{ fontSize: 12 }}>
                  {fmtRunTimestamp(run.started_at)}
                </td>
                <td style={{ fontSize: 12 }}>
                  {run.status === "failed" && run.error ? (
                    <span style={{ color: "var(--pw-danger)" }}>
                      {run.error}
                    </span>
                  ) : run.campaign_id ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => onOpenCampaign(run.campaign_id!)}
                    >
                      Open draft
                    </button>
                  ) : (
                    <span className="muted">No draft</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

interface FeedSourcesBodyProps {
  items: FeedSource[] | null;
  error: string | null;
  loading: boolean;
  latestRuns: Record<string, LatestRun>;
  pollResults: Record<string, FeedPollResult>;
  pollingId: string | null;
  runsFor: string | null;
  runs: RunsState;
  canMutate: boolean;
  actionGuidanceId: string;
  onReload: () => void;
  onPoll: (source: FeedSource) => void;
  onToggleRuns: (source: FeedSource) => void;
  onRetryRuns: (source: FeedSource) => void;
  onEdit: (source: FeedSource) => void;
  onDelete: (source: FeedSource) => void;
  onDismissPollResult: (sourceId: string) => void;
  onOpenCampaign: (campaignId: string) => void;
}

function FeedSourcesBody({
  items,
  error,
  loading,
  latestRuns,
  pollResults,
  pollingId,
  runsFor,
  runs,
  canMutate,
  actionGuidanceId,
  onReload,
  onPoll,
  onToggleRuns,
  onRetryRuns,
  onEdit,
  onDelete,
  onDismissPollResult,
  onOpenCampaign,
}: FeedSourcesBodyProps): ReactElement {
  if (error) {
    return (
      <div className="notice" role="alert">
        <span>Couldn&apos;t load feed sources: {error}</span>
        <button type="button" className="btn btn-sm" onClick={onReload}>
          Retry
        </button>
      </div>
    );
  }
  if (loading && items == null) {
    return (
      <div
        className="skel"
        style={{ height: 40 }}
        role="status"
        aria-label="Loading feed sources"
      />
    );
  }
  if (items?.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        No feed sources yet. Connect an RSS/Atom feed and each poll that finds
        new items creates a draft campaign for review.
      </div>
    );
  }
  return (
    <div className="list" style={{ minWidth: 780 }}>
      <div className="list-header" style={{ gridTemplateColumns: COLS }}>
        <div>Name</div>
        <div>Schedule</div>
        <div>Enabled</div>
        <div>Last polled</div>
        <div>Last run</div>
        <div>Actions</div>
      </div>
      {(items ?? []).map((source) => (
        <div key={source.id}>
          <div className="list-row" style={{ gridTemplateColumns: COLS }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ overflowWrap: "anywhere" }}>{source.name}</div>
              <div
                className="muted mono"
                style={{ fontSize: 11, overflowWrap: "anywhere" }}
              >
                {source.url}
              </div>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {FEED_SCHEDULES.find((option) => option.value === source.schedule)
                ?.label ?? source.schedule}
            </div>
            <div>
              <span className={source.enabled ? "badge accent" : "badge"}>
                {source.enabled ? "On" : "Off"}
              </span>
            </div>
            <div className="muted tabular" style={{ fontSize: 12 }}>
              {lastPolledLabel(source.last_polled_at)}
            </div>
            <div>
              <LatestRunCell latestRun={latestRuns[source.id]} />
            </div>
            <div className="list-row-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  if (canMutate && pollingId == null) onPoll(source);
                }}
                disabled={pollingId != null}
                aria-busy={pollingId === source.id}
                aria-disabled={!canMutate || undefined}
                aria-describedby={actionGuidanceId}
              >
                {pollingId === source.id ? "Polling…" : "Poll now"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onToggleRuns(source)}
                aria-expanded={runsFor === source.id}
                aria-controls={`feed-source-runs-${source.id}`}
              >
                {runsFor === source.id ? "Hide runs" : "Runs"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  if (canMutate) onEdit(source);
                }}
                aria-disabled={!canMutate || undefined}
                aria-describedby={actionGuidanceId}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  if (canMutate) onDelete(source);
                }}
                aria-disabled={!canMutate || undefined}
                aria-describedby={actionGuidanceId}
              >
                Delete
              </button>
            </div>
          </div>
          <PollResultPanel
            source={source}
            result={pollResults[source.id]}
            onOpenCampaign={onOpenCampaign}
            onDismiss={() => onDismissPollResult(source.id)}
          />
          {runsFor === source.id ? (
            <RunsDrilldown
              source={source}
              runs={runs}
              onRetry={() => onRetryRuns(source)}
              onOpenCampaign={onOpenCampaign}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

interface FeedSourcesHeaderProps {
  open: boolean;
  itemCount: number | null;
  loading: boolean;
  canMutate: boolean;
  actionGuidanceId: string;
  onToggle: () => void;
  onReload: () => void;
  onCreate: () => void;
}

function FeedSourcesHeader({
  open,
  itemCount,
  loading,
  canMutate,
  actionGuidanceId,
  onToggle,
  onReload,
  onCreate,
}: FeedSourcesHeaderProps): ReactElement {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="feed-sources-body"
          style={{ fontWeight: 600, fontSize: 13 }}
        >
          {open ? "▾" : "▸"} Recurring (RSS)
        </button>
        <InlineHelp text="Polls an RSS/Atom feed on a schedule and turns new items into DRAFT campaigns. Drafts never send automatically — you review and send each one from the campaigns list." />
        {itemCount != null ? (
          <span className="muted tabular" style={{ fontSize: 12 }}>
            {itemCount} {itemCount === 1 ? "source" : "sources"}
          </span>
        ) : null}
        <span className="spacer" />
        {open ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onReload}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                if (canMutate) onCreate();
              }}
              aria-disabled={!canMutate || undefined}
              aria-describedby={actionGuidanceId}
            >
              New feed source
            </button>
          </>
        ) : null}
      </div>
      {open ? (
        <div
          id={actionGuidanceId}
          className="muted"
          role="status"
          style={{ fontSize: 11, marginTop: 6, overflowWrap: "anywhere" }}
        >
          Poll now fetches the feed and creates draft campaigns for new items;
          it never sends automatically.
          {!canMutate
            ? " Viewer access is read-only, so creating, polling, editing, and deleting feed sources is unavailable."
            : ""}
        </div>
      ) : null}
    </>
  );
}

export function FeedSourcesSection({ onOpenCampaign }: Props): ReactElement {
  const canMutate = useCanWrite();
  const actionGuidanceId = useId();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FeedSource[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [latestRuns, setLatestRuns] = useState<Record<string, LatestRun>>({});

  // Create / edit modal. `editTarget` null + formOpen → create.
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<FeedSource | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<FeedSource | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Poll-now: one in flight at a time; results persist per source so
  // the operator can compare across sources.
  const [pollingId, setPollingId] = useState<string | null>(null);
  const [pollResults, setPollResults] = useState<
    Record<string, FeedPollResult>
  >({});

  // Runs drilldown: one source expanded at a time.
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunsState>({
    loading: false,
    err: null,
    items: null,
  });
  /** Guards against a stale runs response winning a rapid switch race. */
  const runsSeq = useRef(0);
  const latestRunsSeq = useRef(0);
  const loadSeq = useRef(0);
  const mountedRef = useRef(true);
  const loadingRef = useRef(false);
  const pollingRef = useRef(false);
  const deletingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runsSeq.current += 1;
      latestRunsSeq.current += 1;
      loadSeq.current += 1;
    };
  }, []);

  /** Fetch the newest run per source so the list can show last-run
   *  status without a drilldown. Failures render "unavailable", never
   *  a fake "no runs". */
  const loadLatestRuns = async (sources: FeedSource[]): Promise<void> => {
    const seq = ++latestRunsSeq.current;
    setLatestRuns(
      Object.fromEntries(sources.map((s) => [s.id, { kind: "loading" }])),
    );
    await Promise.all(
      sources.map(async (s) => {
        let next: LatestRun;
        try {
          const res = await feedSourcesApi.listRuns(s.id);
          next = res.error
            ? { kind: "unavailable" }
            : res.data.items && res.data.items.length > 0
              ? { kind: "run", run: res.data.items[0]! }
              : { kind: "none" };
        } catch {
          next = { kind: "unavailable" };
        }
        if (!mountedRef.current || seq !== latestRunsSeq.current) return;
        setLatestRuns((prev) => ({
          ...prev,
          [s.id]: next,
        }));
      }),
    );
  };

  const load = async (): Promise<void> => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const seq = ++loadSeq.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await feedSourcesApi.list();
      if (!mountedRef.current || seq !== loadSeq.current) return;
      if (res.error) {
        setErr(res.error.message);
        return;
      }
      const sources = res.data.items ?? [];
      setItems(sources);
      void loadLatestRuns(sources);
    } catch (error) {
      if (!mountedRef.current || seq !== loadSeq.current) return;
      setErr(
        error instanceof Error && error.message
          ? error.message
          : "The feed-source request failed unexpectedly.",
      );
    } finally {
      loadingRef.current = false;
      if (mountedRef.current && seq === loadSeq.current) setLoading(false);
    }
  };

  const toggleOpen = (): void => {
    const next = !open;
    setOpen(next);
    if (next && items == null && !loading) void load();
  };

  const loadRuns = async (sourceId: string): Promise<void> => {
    const seq = ++runsSeq.current;
    setRuns({ loading: true, err: null, items: null });
    try {
      const res = await feedSourcesApi.listRuns(sourceId);
      if (!mountedRef.current || seq !== runsSeq.current) return;
      if (res.error) {
        setRuns({ loading: false, err: res.error.message, items: null });
        return;
      }
      setRuns({ loading: false, err: null, items: res.data.items ?? [] });
    } catch (error) {
      if (!mountedRef.current || seq !== runsSeq.current) return;
      setRuns({
        loading: false,
        err:
          error instanceof Error && error.message
            ? error.message
            : "The run-history request failed unexpectedly.",
        items: null,
      });
    }
  };

  const toggleRuns = (source: FeedSource): void => {
    if (runsFor === source.id) {
      runsSeq.current++; // invalidate any in-flight fetch
      setRunsFor(null);
      setRuns({ loading: false, err: null, items: null });
      return;
    }
    setRunsFor(source.id);
    void loadRuns(source.id);
  };

  const pollNow = async (source: FeedSource): Promise<void> => {
    if (!canMutate || pollingRef.current) return;
    pollingRef.current = true;
    setPollingId(source.id);
    try {
      const res = await feedSourcesApi.poll(source.id);
      if (!mountedRef.current) return;
      if (res.error) {
        // Transport/404/503 only — a FAILED poll still lands in res.data.
        toast.error({
          message: `Couldn't poll "${source.name}"`,
          detail: res.error.message,
        });
        return;
      }
      setPollResults((prev) => ({ ...prev, [source.id]: res.data }));
      await load();
      if (runsFor === source.id) void loadRuns(source.id);
    } catch (error) {
      if (!mountedRef.current) return;
      toast.error({
        message: `Couldn't poll "${source.name}"`,
        detail:
          error instanceof Error && error.message
            ? error.message
            : "The poll request failed unexpectedly.",
      });
    } finally {
      pollingRef.current = false;
      if (mountedRef.current) setPollingId(null);
    }
  };

  const submitDelete = async (): Promise<void> => {
    if (!canMutate || !deleteTarget || deletingRef.current) return;
    const target = deleteTarget;
    deletingRef.current = true;
    setDeleting(true);
    try {
      const res = await feedSourcesApi.remove(target.id);
      if (!mountedRef.current) return;
      if (res.error) {
        toast.error({
          message: `Couldn't delete "${target.name}"`,
          detail: res.error.message,
        });
        return;
      }
      if (runsFor === target.id) {
        runsSeq.current++;
        setRunsFor(null);
        setRuns({ loading: false, err: null, items: null });
      }
      setPollResults((prev) => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
      setDeleteTarget((current) =>
        current?.id === target.id ? null : current,
      );
      toast.success(`Feed source "${target.name}" deleted`);
      await load();
    } catch (error) {
      if (!mountedRef.current) return;
      toast.error({
        message: `Couldn't delete "${target.name}"`,
        detail:
          error instanceof Error && error.message
            ? error.message
            : "The delete request failed unexpectedly.",
      });
    } finally {
      deletingRef.current = false;
      if (mountedRef.current) setDeleting(false);
    }
  };

  return (
    <section className="card" style={{ marginTop: 16, padding: 16 }}>
      <FeedSourcesHeader
        open={open}
        itemCount={items?.length ?? null}
        loading={loading}
        canMutate={canMutate}
        actionGuidanceId={actionGuidanceId}
        onToggle={toggleOpen}
        onReload={() => void load()}
        onCreate={() => {
          setEditTarget(null);
          setFormOpen(true);
        }}
      />

      {open ? (
        <div
          id="feed-sources-body"
          style={{ marginTop: 12, overflowX: "auto" }}
          aria-busy={loading}
        >
          <FeedSourcesBody
            items={items}
            error={err}
            loading={loading}
            latestRuns={latestRuns}
            pollResults={pollResults}
            pollingId={pollingId}
            runsFor={runsFor}
            runs={runs}
            canMutate={canMutate}
            actionGuidanceId={actionGuidanceId}
            onReload={() => void load()}
            onPoll={(source) => void pollNow(source)}
            onToggleRuns={toggleRuns}
            onRetryRuns={(source) => void loadRuns(source.id)}
            onEdit={(source) => {
              setEditTarget(source);
              setFormOpen(true);
            }}
            onDelete={setDeleteTarget}
            onDismissPollResult={(sourceId) =>
              setPollResults((previous) => {
                const next = { ...previous };
                delete next[sourceId];
                return next;
              })
            }
            onOpenCampaign={onOpenCampaign}
          />
        </div>
      ) : null}

      <FeedSourceFormModal
        open={formOpen}
        source={editTarget}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          void load();
        }}
      />

      <ConfirmModal
        open={deleteTarget != null}
        title={`Delete "${deleteTarget?.name ?? "feed source"}"?`}
        description="Stops all future polls for this feed. Draft campaigns it already created stay in your campaigns list."
        confirmLabel="Delete feed source"
        busy={deleting}
        onConfirm={() => void submitDelete()}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
      />
    </section>
  );
}
