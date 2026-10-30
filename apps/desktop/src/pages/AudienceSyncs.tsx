/**
 * AudienceSyncs — working reverse-ETL surface (A13).
 *
 * Replaces the old "Coming soon" stub. Each sync pushes a list's /
 * segment's members to a tenant webhook in HMAC-signed batches
 * (X-Postwave-Signature — same convention as outbound webhooks), either
 * manually ("Run now") or on an hourly/daily schedule.
 *
 *   - List all syncs with source, destination, schedule + last-run status
 *   - Create / edit via AudienceSyncFormModal (source picker is fed by
 *     the live lists + segments APIs)
 *   - Row click → AudienceSyncRunsSlideover (run history + Run now)
 *   - Delete with confirm
 *
 * Honest-UI rules: load failures own the error state (404 → "not enabled
 * on this server"), never the onboarding hero. The run drilldown classifies
 * receiver failures and exposes support IDs without rendering verbatim
 * upstream text that may contain credentials, URLs, payloads, or PII.
 * RBAC: `useCanAdmin` gates every mutator; viewers see read-only controls.
 *
 * Backend: apps/api/internal/audience_destinations/sync_handlers.go.
 *
 * Adapter-backed ad-platform destination foundations (SUB-113 — Meta /
 * Google Ads / TikTok / LinkedIn / Snap Custom Audiences with consent-aware
 * exclusion) render below the webhook syncs via AudienceDestinationsSection,
 * backed by apps/api/internal/audience_destinations/handlers.go.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { AudienceDestinationsSection } from "../components/AudienceDestinationsSection";
import { WritebackTargetsSection } from "../components/WritebackTargetsSection";
import { AudienceSyncFormModal } from "../components/audiencesync/AudienceSyncFormModal";
import { AudienceSyncRunsSlideover } from "../components/audiencesync/AudienceSyncRunsSlideover";
import { ConfirmModal } from "../components/ConfirmModal";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { PageHeader } from "../components/PageHeader";
import { toast } from "../components/Toast";
import { audienceSyncsApi, type AudienceSync } from "../lib/api-client";
import { useCapabilityReporter } from "../lib/capability-observations";
import { HERO } from "../lib/heroAssets";
import { useCanAdmin } from "../lib/store";

const COLS = "1.6fr 1fr 110px 110px 1.2fr 170px";

function relativeAgo(s: string | null | undefined): string {
  if (!s) return "never";
  try {
    const ms = Date.now() - new Date(s).getTime();
    if (Number.isNaN(ms) || ms < 0) return s;
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.round(hr / 24)}d ago`;
  } catch {
    return s;
  }
}

function lastRunBadge(s: AudienceSync): ReactElement {
  if (!s.last_run_at) return <span className="badge">Never run</span>;
  const status = (s.last_run_status ?? "").toLowerCase();
  const when = relativeAgo(s.last_run_at);
  if (status === "succeeded") {
    return <span className="badge success">Succeeded · {when}</span>;
  }
  if (status === "failed") {
    return <span className="badge danger">Failed · {when}</span>;
  }
  if (status === "running") {
    return <span className="badge warning">Running · {when}</span>;
  }
  return (
    <span className="badge">
      {s.last_run_status || "—"} · {when}
    </span>
  );
}

function scheduleLabel(s: string | null | undefined): string {
  switch (s) {
    case "hourly":
      return "Hourly";
    case "daily":
      return "Daily";
    case "manual":
      return "Manual";
    default:
      return s || "—";
  }
}

function sourceLabel(s: AudienceSync): string {
  // `source` (and its ids) can be absent on an incomplete row — guard
  // every read so a partial sync renders "—" instead of crashing.
  const segId = s.source?.segment_id ?? "";
  if (segId) return `Segment · ${shortIdentifier(segId)}`;
  const listId = s.source?.list_id ?? "";
  if (listId) return `List · ${shortIdentifier(listId)}`;
  return "—";
}

function shortIdentifier(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

/** Never render URL credentials, query tokens, or fragments into a table. */
export function safeDestinationLabel(raw: string | null | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) return "—";
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] || "—";
  }
}

interface AudienceSyncListProps {
  rows: AudienceSync[];
  loading: boolean;
  error: string | null;
  query: string;
  canAdmin: boolean;
  runningId: string | null;
  mutationsLocked: boolean;
  onCreate: () => void;
  onSelect: (sync: AudienceSync) => void;
  onRun: (sync: AudienceSync) => void;
  onEdit: (sync: AudienceSync) => void;
  onDelete: (sync: AudienceSync) => void;
}

function AudienceSyncList({
  rows,
  loading,
  error,
  query,
  canAdmin,
  runningId,
  mutationsLocked,
  onCreate,
  onSelect,
  onRun,
  onEdit,
  onDelete,
}: AudienceSyncListProps): ReactElement {
  return (
    <div className="list">
      <div className="list-header" style={{ gridTemplateColumns: COLS }}>
        <div>Name</div>
        <div>Source</div>
        <div>Schedule</div>
        <div>Enabled</div>
        <div>Last run</div>
        <div />
      </div>
      {loading ? (
        <div style={{ padding: 4 }}>
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="skel-row">
              <div className="skel skel-cell lg" />
              <div className="skel skel-cell" />
              <div className="skel skel-cell sm" />
              <div className="skel skel-cell sm" />
              <div className="skel skel-cell" />
              <div className="skel skel-cell sm" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        error ? (
          <div className="list-empty">
            <div className="empty-state">
              <div className="empty-state-icon">·</div>
              <h3>Couldn&apos;t load audience syncs</h3>
              <p>{error}</p>
            </div>
          </div>
        ) : query ? (
          <div className="list-empty">
            <div className="empty-state">
              <div className="empty-state-icon">·</div>
              <h3>No matches for &quot;{query}&quot;</h3>
              <p>Clear search to see all syncs.</p>
            </div>
          </div>
        ) : (
          <HeroEmptyState
            tone="mint"
            eyebrow="Audience"
            title="Keep every system in sync with your audience."
            subtitle="Push a list or segment to any webhook receiver — CRM, warehouse loader, your own service — as HMAC-signed batches, on demand or on a schedule."
            imageSrc={HERO.lists}
            imageAlt="Stacked index cards representing audience lists"
            primaryCta={
              canAdmin ? { label: "New sync", onClick: onCreate } : undefined
            }
            meta="Webhook destinations work end-to-end today. Readiness-gated ad-platform audience foundations live in the section below."
          />
        )
      ) : (
        rows.map((sync) => {
          const destination = safeDestinationLabel(sync.destination?.url);
          const runReasonId = `audience-sync-run-reason-${sync.id}`;
          const runUnavailableReason = mutationsLocked
            ? "Wait for the current audience-sync operation to finish."
            : !sync.enabled
              ? "Enable this audience sync before running it."
              : null;
          return (
            <div
              key={sync.id}
              className="list-row"
              style={{ gridTemplateColumns: COLS }}
              role="button"
              tabIndex={0}
              aria-label={`Audience sync · ${sync.name}`}
              onClick={() => onSelect(sync)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(sync);
                }
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {sync.name || "(unnamed sync)"}
                </div>
                <div
                  className="mono muted"
                  style={{
                    fontSize: 11,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={destination}
                >
                  {destination}
                </div>
              </div>
              <div className="muted tabular" style={{ fontSize: 12 }}>
                {sourceLabel(sync)}
              </div>
              <div className="muted tabular" style={{ fontSize: 12 }}>
                {scheduleLabel(sync.schedule)}
              </div>
              <div>
                {sync.enabled ? (
                  <span className="badge success">On</span>
                ) : (
                  <span className="badge">Off</span>
                )}
              </div>
              <div style={{ fontSize: 12 }}>{lastRunBadge(sync)}</div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {canAdmin ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-disabled={runUnavailableReason ? true : undefined}
                      aria-describedby={
                        runUnavailableReason ? runReasonId : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        if (runUnavailableReason) return;
                        onRun(sync);
                      }}
                    >
                      {runningId === sync.id ? "Running…" : "Run now"}
                    </button>
                    {runUnavailableReason ? (
                      <span
                        id={runReasonId}
                        className="muted"
                        style={{ fontSize: 11 }}
                      >
                        {runUnavailableReason}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={mutationsLocked}
                      onClick={(event) => {
                        event.stopPropagation();
                        onEdit(sync);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={mutationsLocked}
                      aria-label={`Delete ${sync.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(sync);
                      }}
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(sync);
                    }}
                  >
                    Runs
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export function AudienceSyncs(): ReactElement {
  const activeRef = useRef(true);
  const loadRequestRef = useRef(0);
  const actionRequestRef = useRef(0);
  const mutationRef = useRef(false);
  const runningRef = useRef<string | null>(null);
  const canAdmin = useCanAdmin();
  const { available, fromApiError, partialNotConfigured } =
    useCapabilityReporter("audienceSyncs", "webhook-sync");
  const [rows, setRows] = useState<AudienceSync[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Form modal: undefined → closed, null → create, sync → edit.
  const [formTarget, setFormTarget] = useState<AudienceSync | null | undefined>(
    undefined,
  );
  const [selected, setSelected] = useState<AudienceSync | null>(null);
  const [deleting, setDeleting] = useState<AudienceSync | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setErr(null);
    const res = await audienceSyncsApi.list();
    if (!activeRef.current || requestId !== loadRequestRef.current) return;
    if (res.error) {
      if (res.error.status === 404 || res.error.status === 405) {
        partialNotConfigured(
          "Webhook audience sync is not enabled on this server. Ad-platform destinations and writeback tools remain independently available below.",
        );
      } else {
        fromApiError(res.error, { impact: "partial" });
      }
      // 404/405 → backend without the audience-syncs routes. Say so plainly
      // instead of rendering it as a transient outage.
      setErr(
        res.error.status === 404 || res.error.status === 405
          ? "Audience syncs aren't enabled on this Moosewave server. Update the API and try again."
          : res.error.message,
      );
      setRows([]);
      setSelected(null);
    } else {
      available();
      const items = res.data?.items ?? [];
      setRows(items);
      setSelected((current) =>
        current ? (items.find((item) => item.id === current.id) ?? null) : null,
      );
    }
    setLoading(false);
  }, [available, fromApiError, partialNotConfigured]);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
      loadRequestRef.current += 1;
      actionRequestRef.current += 1;
      mutationRef.current = false;
      runningRef.current = null;
    };
  }, [load]);

  const filtered = useMemo<AudienceSync[]>(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.name ?? "").toLowerCase().includes(q) ||
        (r.destination?.url ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const runNow = async (s: AudienceSync): Promise<void> => {
    if (!canAdmin || mutationRef.current) return;
    const requestId = ++actionRequestRef.current;
    mutationRef.current = true;
    runningRef.current = s.id;
    setRunningId(s.id);
    const res = await audienceSyncsApi.run(s.id);
    if (!activeRef.current || requestId !== actionRequestRef.current) return;
    mutationRef.current = false;
    runningRef.current = null;
    setRunningId(null);
    if (res.error) {
      toast.error(`Run failed to start: ${res.error.message}`);
      return;
    }
    const run = res.data;
    const syncName = s.name || "Sync";
    if (run?.status === "succeeded") {
      const rows = run.rows_exported ?? 0;
      const batches = run.batches_sent ?? 0;
      toast.success(
        `${syncName}: exported ${rows.toLocaleString()} rows in ${batches.toLocaleString()} batch${batches === 1 ? "" : "es"}`,
      );
    } else {
      toast.error(
        `${syncName}: run ${run?.status ?? "finished"} — ${run?.error || "open run history for details"}`,
      );
    }
    await load();
  };

  const confirmDelete = async (): Promise<void> => {
    if (!canAdmin || !deleting || mutationRef.current) return;
    const target = deleting;
    const requestId = ++actionRequestRef.current;
    mutationRef.current = true;
    setDeleteBusy(true);
    const res = await audienceSyncsApi.remove(target.id);
    if (!activeRef.current || requestId !== actionRequestRef.current) return;
    mutationRef.current = false;
    setDeleteBusy(false);
    if (res.error) {
      toast.error(`Delete failed: ${res.error.message}`);
      return;
    }
    toast.success(`Deleted "${target.name || "sync"}"`);
    setDeleting(null);
    await load();
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Audience"
        title="Audience syncs"
        subtitle={
          rows
            ? `${filtered.length.toLocaleString()} sync${filtered.length === 1 ? "" : "s"} — push lists and segments to your systems as signed webhook batches.`
            : "Loading syncs…"
        }
        actions={[
          { label: "Refresh", onClick: () => void load(), variant: "ghost" },
          ...(canAdmin && rows && rows.length > 0
            ? [
                {
                  label: "New sync",
                  onClick: () => setFormTarget(null),
                  disabled: runningId !== null || deleteBusy,
                },
              ]
            : []),
        ]}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <input
          type="search"
          className="input"
          style={{ width: 280 }}
          aria-label="Search audience syncs by name or destination URL"
          placeholder="Search name or URL…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="spacer" />
      </div>

      {err ? (
        <div className="notice" role="alert">
          <span>{err}</span>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: 8 }}
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}

      <AudienceSyncList
        rows={filtered}
        loading={loading}
        error={err}
        query={query}
        canAdmin={canAdmin}
        runningId={runningId}
        mutationsLocked={runningId !== null || deleteBusy}
        onCreate={() => setFormTarget(null)}
        onSelect={setSelected}
        onRun={(sync) => void runNow(sync)}
        onEdit={setFormTarget}
        onDelete={setDeleting}
      />

      {/* SUB-113 — readiness-gated ad-platform audience foundations
          (Meta / Google / TikTok / LinkedIn / Snap). */}
      <AudienceDestinationsSection canAdmin={canAdmin} />

      {/* Direct-API write-back: push a list/segment + per-member traits back
          into Shopify / HubSpot / Salesforce / Pipedrive / Klaviyo. */}
      <WritebackTargetsSection canAdmin={canAdmin} />

      {selected ? (
        <AudienceSyncRunsSlideover
          sync={selected}
          canRun={canAdmin}
          onClose={() => setSelected(null)}
          onRan={() => void load()}
        />
      ) : null}

      <AudienceSyncFormModal
        open={formTarget !== undefined}
        sync={formTarget ?? null}
        onClose={() => setFormTarget(undefined)}
        onSaved={() => {
          setFormTarget(undefined);
          void load();
        }}
      />

      <ConfirmModal
        open={deleting !== null}
        title="Delete audience sync?"
        description={
          deleting
            ? `"${deleting.name}" and its run history will be removed. The receiver keeps whatever was already delivered.`
            : undefined
        }
        confirmLabel="Delete sync"
        danger
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          if (!deleteBusy) setDeleting(null);
        }}
      />
    </div>
  );
}
