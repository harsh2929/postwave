/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- bounded overflow regions must be keyboard-scrollable. */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { HeroEmptyState } from "../HeroEmptyState";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  AUTOMATION_SURFACE_BOUNDARIES,
  ZERO_COPY_LIVE_POLL_AVAILABLE,
} from "../../lib/automation-operational-availability";
import {
  type ZeroCopyTrigger,
  zeroCopyTriggersApi,
} from "../../lib/api-client";
import { HERO } from "../../lib/heroAssets";

import { normalizeTriggerDefinitionsPage } from "./response-normalizers";
import { TriggerDetailSlideover } from "./TriggerDetailSlideover";
import { TriggerEditorModal } from "./TriggerEditorModal";
import { fmtDuration, fmtRelative, triggerHealth } from "./zero-copy-helpers";

const STATUS_FILTERS = ["all", "draft", "paused", "error", "active"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
type LoadMode = "switch" | "refresh" | "more";
const TRIGGER_PAGE_SIZE = 200;

interface TriggerListState {
  rows: ZeroCopyTrigger[] | null;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  stale: boolean;
  failedMode: LoadMode | null;
  updatedAt: number | null;
  nextCursor: string | null;
  totalEstimate: number | null;
}

interface TriggerListSnapshot {
  rows: ZeroCopyTrigger[];
  nextCursor: string | null;
  totalEstimate: number | null;
}

const INITIAL_LIST_STATE: TriggerListState = {
  rows: null,
  loading: true,
  refreshing: false,
  loadingMore: false,
  error: null,
  stale: false,
  failedMode: null,
  updatedAt: null,
  nextCursor: null,
  totalEstimate: null,
};

export function ZeroCopyTriggersSection({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const [list, setList] = useState<TriggerListState>(INITIAL_LIST_STATE);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<ZeroCopyTrigger | null>(null);
  const [deleting, setDeleting] = useState<ZeroCopyTrigger | null>(null);
  const [selected, setSelected] = useState<ZeroCopyTrigger | null>(null);
  const requestSequenceRef = useRef(0);
  const cacheRef = useRef(new Map<StatusFilter, TriggerListSnapshot>());
  const listRef = useRef<TriggerListState>(INITIAL_LIST_STATE);
  listRef.current = list;
  const canAdminRef = useRef(canAdmin);
  const authorityEpochRef = useRef(0);
  const editorEpochRef = useRef(0);
  if (canAdminRef.current !== canAdmin) {
    canAdminRef.current = canAdmin;
    authorityEpochRef.current += 1;
  }
  const mountedRef = useRef(true);
  const runtimeHelpId = useId();

  const deleteOperation = usePersistentLifecycleOperation({
    ownerId: "automations-zero-copy-delete",
    label: "Deleting warehouse trigger definition",
    detail: "Wait for the trigger deletion request to finish before exiting.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);

  const load = useCallback(
    async (
      statusFilter: StatusFilter,
      mode: LoadMode,
      cursor?: string,
    ): Promise<void> => {
      if (!canAdminRef.current) return;
      if (mode === "more" && !cursor) return;
      const authorityEpoch = authorityEpochRef.current;
      const requestId = ++requestSequenceRef.current;
      const cached = cacheRef.current.get(statusFilter) ?? null;
      const current = listRef.current;
      const retainedSnapshot =
        mode === "switch"
          ? cached
          : current.rows
            ? {
                rows: current.rows,
                nextCursor: current.nextCursor,
                totalEstimate: current.totalEstimate,
              }
            : null;
      setList((previous) => {
        return {
          rows: retainedSnapshot?.rows ?? null,
          loading: retainedSnapshot === null,
          refreshing: mode !== "more" && retainedSnapshot !== null,
          loadingMore: mode === "more",
          error: null,
          stale: false,
          failedMode: null,
          updatedAt: mode === "switch" ? null : previous.updatedAt,
          nextCursor: retainedSnapshot?.nextCursor ?? null,
          totalEstimate: retainedSnapshot?.totalEstimate ?? null,
        };
      });

      try {
        const response = await zeroCopyTriggersApi.list({
          ...(statusFilter === "all" ? {} : { status: statusFilter }),
          ...(mode === "more" && cursor ? { cursor } : {}),
          limit: TRIGGER_PAGE_SIZE,
        });
        if (
          !mountedRef.current ||
          !canAdminRef.current ||
          authorityEpoch !== authorityEpochRef.current ||
          requestId !== requestSequenceRef.current
        ) {
          return;
        }
        if (response.error) {
          setList((previous) => ({
            ...previous,
            loading: false,
            refreshing: false,
            loadingMore: false,
            error:
              "The trigger definition list could not be loaded. Retry, then review secure service logs if it persists.",
            stale: previous.rows !== null,
            failedMode: mode,
          }));
          return;
        }
        const normalized = normalizeTriggerDefinitionsPage(response.data);
        if (!normalized.ok) {
          setList((previous) => ({
            ...previous,
            loading: false,
            refreshing: false,
            loadingMore: false,
            error: normalized.message,
            stale: previous.rows !== null,
            failedMode: mode,
          }));
          return;
        }
        const page = normalized.value;
        if (mode === "more" && page.nextCursor === cursor) {
          setList((previous) => ({
            ...previous,
            loading: false,
            refreshing: false,
            loadingMore: false,
            error:
              "The server repeated the same pagination cursor. Loaded definitions were retained.",
            stale: previous.rows !== null,
            failedMode: mode,
          }));
          return;
        }
        const baseRows = mode === "more" ? (retainedSnapshot?.rows ?? []) : [];
        const ids = new Set(baseRows.map((row) => row.id));
        if (page.items.some((row) => row.id && ids.has(row.id))) {
          setList((previous) => ({
            ...previous,
            loading: false,
            refreshing: false,
            loadingMore: false,
            error:
              "The server returned overlapping trigger pages. Loaded definitions were retained.",
            stale: previous.rows !== null,
            failedMode: mode,
          }));
          return;
        }
        const rows = [...baseRows, ...page.items];
        const snapshot: TriggerListSnapshot = {
          rows,
          nextCursor: page.nextCursor ?? null,
          totalEstimate:
            page.totalEstimate ?? retainedSnapshot?.totalEstimate ?? null,
        };
        cacheRef.current.set(statusFilter, snapshot);
        setList({
          rows,
          loading: false,
          refreshing: false,
          loadingMore: false,
          error: null,
          stale: false,
          failedMode: null,
          updatedAt: Date.now(),
          nextCursor: snapshot.nextCursor,
          totalEstimate: snapshot.totalEstimate,
        });
        setSelected((current) =>
          current?.id
            ? (rows.find((row) => row.id === current.id) ?? current)
            : current,
        );
      } catch {
        if (
          !mountedRef.current ||
          !canAdminRef.current ||
          authorityEpoch !== authorityEpochRef.current ||
          requestId !== requestSequenceRef.current
        ) {
          return;
        }
        setList((previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          loadingMore: false,
          error:
            "The trigger definition list request did not complete. Retry, then review secure service logs if it persists.",
          stale: previous.rows !== null,
          failedMode: mode,
        }));
      }
    },
    [],
  );

  useEffect(() => {
    if (!canAdmin) {
      requestSequenceRef.current += 1;
      cacheRef.current.clear();
      setList({ ...INITIAL_LIST_STATE, loading: false });
      setShowCreate(false);
      setEditing(null);
      setDeleting(null);
      setSelected(null);
      return;
    }
    void load(filter, "switch");
  }, [canAdmin, filter, load]);

  const reload = useCallback(
    (): Promise<void> => load(filter, "refresh"),
    [filter, load],
  );

  const loadMore = useCallback((): void => {
    const cursor = listRef.current.nextCursor;
    if (!cursor || listRef.current.loadingMore) return;
    void load(filter, "more", cursor);
  }, [filter, load]);
  const { pollingId, pollNow } = useZeroCopyPoll({
    canAdminRef,
    authorityEpochRef,
    mountedRef,
    reload,
  });

  const confirmDelete = async (): Promise<void> => {
    const id = deleting?.id;
    if (!id || !canAdminRef.current) return;
    const authorityEpoch = authorityEpochRef.current;
    const pending = deleteOperation.run(() => zeroCopyTriggersApi.remove(id));
    if (!pending) return;
    try {
      const response = await pending;
      if (!canAdminRef.current || authorityEpoch !== authorityEpochRef.current)
        return;
      if (response.error) {
        toast.error({
          message: "Couldn't delete trigger definition",
          detail: "Review secure service logs for the operational error.",
        });
        return;
      }
      toast.success("Trigger definition deleted");
      if (mountedRef.current) {
        setDeleting(null);
        setSelected((current) => (current?.id === id ? null : current));
      }
      await reload();
    } catch {
      if (!canAdminRef.current || authorityEpoch !== authorityEpochRef.current)
        return;
      toast.error({
        message: "Couldn't delete trigger definition",
        detail: "The deletion request did not complete.",
      });
    }
  };

  const openCreate = (): void => {
    editorEpochRef.current = authorityEpochRef.current;
    setShowCreate(true);
  };
  const openEdit = (trigger: ZeroCopyTrigger): void => {
    editorEpochRef.current = authorityEpochRef.current;
    setEditing(trigger);
  };
  const finishEditorSave = async (
    mode: "create" | "edit",
  ): Promise<boolean> => {
    const editorEpoch = editorEpochRef.current;
    if (!canAdminRef.current || editorEpoch !== authorityEpochRef.current)
      return false;
    await reload();
    if (!canAdminRef.current || editorEpoch !== authorityEpochRef.current)
      return false;
    if (mode === "create") setShowCreate(false);
    else setEditing(null);
    return true;
  };

  return (
    <ZeroCopyTriggersSurface
      canAdmin={canAdmin}
      list={list}
      filter={filter}
      runtimeHelpId={runtimeHelpId}
      pollingId={pollingId}
      showCreate={showCreate}
      editing={editing}
      deleting={deleting}
      selected={selected}
      deleteBusy={deleteOperation.active}
      onFilter={setFilter}
      onReload={() => void reload()}
      onLoadMore={loadMore}
      onCreate={openCreate}
      onEdit={openEdit}
      onDelete={setDeleting}
      onSelect={setSelected}
      onPoll={(trigger) => void pollNow(trigger)}
      onCloseCreate={() => setShowCreate(false)}
      onCloseEdit={() => setEditing(null)}
      onSaved={finishEditorSave}
      onConfirmDelete={() => void confirmDelete()}
      onCloseDelete={() => {
        if (!deleteOperation.promiseRef.current) setDeleting(null);
      }}
    />
  );
}

interface ZeroCopyTriggersSurfaceProps {
  canAdmin: boolean;
  list: TriggerListState;
  filter: StatusFilter;
  runtimeHelpId: string;
  pollingId: string | null;
  showCreate: boolean;
  editing: ZeroCopyTrigger | null;
  deleting: ZeroCopyTrigger | null;
  selected: ZeroCopyTrigger | null;
  deleteBusy: boolean;
  onFilter: (filter: StatusFilter) => void;
  onReload: () => void;
  onLoadMore: () => void;
  onCreate: () => void;
  onEdit: (trigger: ZeroCopyTrigger) => void;
  onDelete: (trigger: ZeroCopyTrigger | null) => void;
  onSelect: (trigger: ZeroCopyTrigger | null) => void;
  onPoll: (trigger: ZeroCopyTrigger) => void;
  onCloseCreate: () => void;
  onCloseEdit: () => void;
  onSaved: (mode: "create" | "edit") => Promise<boolean>;
  onConfirmDelete: () => void;
  onCloseDelete: () => void;
}

function ZeroCopyTriggersSurface({
  canAdmin,
  list,
  filter,
  runtimeHelpId,
  pollingId,
  showCreate,
  editing,
  deleting,
  selected,
  deleteBusy,
  onFilter,
  onReload,
  onLoadMore,
  onCreate,
  onEdit,
  onDelete,
  onSelect,
  onPoll,
  onCloseCreate,
  onCloseEdit,
  onSaved,
  onConfirmDelete,
  onCloseDelete,
}: ZeroCopyTriggersSurfaceProps): ReactElement {
  const boundary = AUTOMATION_SURFACE_BOUNDARIES["warehouse-triggers"];
  return (
    <section
      id="warehouse-trigger-drafts"
      className="automations-surface"
      aria-label="Warehouse trigger drafts"
    >
      <SectionHeader
        title="Warehouse trigger drafts"
        description="Define and validate cursor-based warehouse queries. Stored drafts do not poll, start journeys, or prove execution in this build."
        helpText="Definitions load in cursor-paginated pages of 200. Input validation checks configuration shape and query policy; it is not a live warehouse dry run."
        actions={
          canAdmin ? (
            <div className="automations-toolbar">
              <select
                value={filter}
                aria-label="Filter trigger definitions by status"
                onChange={(event) =>
                  onFilter(event.target.value as StatusFilter)
                }
              >
                {STATUS_FILTERS.map((status) => (
                  <option key={status} value={status}>
                    {status === "all" ? "All stored statuses" : status}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn"
                aria-label="Refresh trigger definitions"
                disabled={list.loading || list.refreshing || list.loadingMore}
                onClick={onReload}
              >
                {list.refreshing ? "Refreshing…" : "Refresh"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onCreate}
              >
                + New trigger draft
              </button>
            </div>
          ) : undefined
        }
      />

      <div className="automations-boundary" id={runtimeHelpId}>
        <div>
          <span className="automations-boundary__label">Available</span>
          <strong>{boundary.available}</strong>
        </div>
        <div data-blocked="true">
          <span className="automations-boundary__label">Unavailable</span>
          <strong>{boundary.unavailable}</strong>
        </div>
      </div>

      {canAdmin ? (
        <TriggerListContent
          list={list}
          rows={list.rows}
          filter={filter}
          isFiltered={filter !== "all"}
          canAdmin
          pollingId={pollingId}
          runtimeHelpId={runtimeHelpId}
          onReload={onReload}
          onLoadMore={onLoadMore}
          onCreate={onCreate}
          onSelect={onSelect}
          onEdit={onEdit}
          onDelete={onDelete}
          onPoll={onPoll}
        />
      ) : (
        <div className="automations-load-error" role="note">
          <strong>Admin access required</strong>
          <span>
            Warehouse definitions can contain SQL, provider configuration, and
            connection references. This role does not load or display them.
          </span>
        </div>
      )}

      {canAdmin && showCreate ? (
        <TriggerEditorModal
          mode="create"
          onClose={onCloseCreate}
          onSaved={() => onSaved("create")}
        />
      ) : null}

      {canAdmin && editing ? (
        <TriggerEditorModal
          mode="edit"
          existing={editing}
          onClose={onCloseEdit}
          onSaved={() => onSaved("edit")}
        />
      ) : null}

      {canAdmin && deleting ? (
        <ConfirmModal
          open
          danger
          title={`Delete “${deleting.name}”?`}
          description="This removes the stored definition and its related inspection history. It cannot cancel work that may already have been accepted by another runtime. This can't be undone."
          confirmLabel="Delete definition"
          busy={deleteBusy}
          onConfirm={onConfirmDelete}
          onClose={onCloseDelete}
        />
      ) : null}

      {canAdmin && selected ? (
        <TriggerDetailSlideover
          trigger={selected}
          canAdmin={canAdmin}
          onClose={() => onSelect(null)}
          onChanged={async () => onReload()}
        />
      ) : null}
    </section>
  );
}

function useZeroCopyPoll({
  canAdminRef,
  authorityEpochRef,
  mountedRef,
  reload,
}: {
  canAdminRef: { current: boolean };
  authorityEpochRef: { current: number };
  mountedRef: { current: boolean };
  reload: () => Promise<void>;
}): {
  pollingId: string | null;
  pollNow: (trigger: ZeroCopyTrigger) => Promise<void>;
} {
  const [pollingId, setPollingId] = useState<string | null>(null);
  const pollOperation = usePersistentLifecycleOperation({
    ownerId: "automations-zero-copy-poll",
    label: "Polling warehouse trigger",
    detail: "Wait for the warehouse poll request to finish before exiting.",
  });
  const pollNow = async (trigger: ZeroCopyTrigger): Promise<void> => {
    if (!canAdminRef.current || !ZERO_COPY_LIVE_POLL_AVAILABLE || !trigger.id)
      return;
    const authorityEpoch = authorityEpochRef.current;
    const pending = pollOperation.run(() =>
      zeroCopyTriggersApi.pollNow(trigger.id!),
    );
    if (!pending) return;
    if (mountedRef.current) setPollingId(trigger.id);
    try {
      const response = await pending;
      if (!canAdminRef.current || authorityEpoch !== authorityEpochRef.current)
        return;
      if (response.error) {
        toast.error({
          message: "Poll failed",
          detail: "Review secure service logs for the operational error.",
        });
        return;
      }
      toast.info({
        message: "Poll request completed",
        detail: `${response.data?.count ?? 0} enqueue record(s) returned. This is not execution or delivery proof.`,
      });
      await reload();
    } catch {
      if (!canAdminRef.current || authorityEpoch !== authorityEpochRef.current)
        return;
      toast.error({
        message: "Poll failed",
        detail: "The warehouse poll request did not complete.",
      });
    } finally {
      if (mountedRef.current) setPollingId(null);
    }
  };
  return { pollingId, pollNow };
}

function TriggerListContent({
  list,
  rows,
  filter,
  isFiltered,
  canAdmin,
  pollingId,
  runtimeHelpId,
  onReload,
  onLoadMore,
  onCreate,
  onSelect,
  onEdit,
  onDelete,
  onPoll,
}: {
  list: TriggerListState;
  rows: ZeroCopyTrigger[] | null;
  filter: StatusFilter;
  isFiltered: boolean;
  canAdmin: boolean;
  pollingId: string | null;
  runtimeHelpId: string;
  onReload: () => void;
  onLoadMore: () => void;
  onCreate: () => void;
  onSelect: (trigger: ZeroCopyTrigger) => void;
  onEdit: (trigger: ZeroCopyTrigger) => void;
  onDelete: (trigger: ZeroCopyTrigger) => void;
  onPoll: (trigger: ZeroCopyTrigger) => void;
}): ReactElement | null {
  if (rows === null && list.loading) {
    return (
      <div className="automations-loading" role="status">
        <span className="automations-spinner" aria-hidden="true" />
        Loading trigger definitions…
      </div>
    );
  }
  if (rows === null && list.error) {
    return (
      <div className="automations-load-error" role="alert">
        <strong>Trigger definitions are unavailable.</strong>
        <span>{list.error}</span>
        <button type="button" className="btn" onClick={onReload}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <>
      {list.error && list.stale ? (
        <div className="callout warning" role="status">
          <strong>Showing the last loaded trigger definitions.</strong>{" "}
          {list.failedMode === "more" ? "Load more" : "Refresh"} failed.
          <button
            type="button"
            className="link-button"
            onClick={list.failedMode === "more" ? onLoadMore : onReload}
          >
            {list.failedMode === "more" ? "Retry load more" : "Try again"}
          </button>
        </div>
      ) : null}
      {rows?.length === 0 ? (
        isFiltered ? (
          <div className="automations-inline-empty">
            <strong>No {filter} definitions</strong>
            <span>Choose “All stored statuses” to inspect other drafts.</span>
          </div>
        ) : (
          <HeroEmptyState
            tone="blue"
            eyebrow="Warehouse drafts"
            title="Start with an inert, reviewable definition."
            subtitle="Describe the query, cursor, profile key, and intended journey. You can validate and review the draft here; activation remains unavailable."
            primaryCta={
              canAdmin
                ? { label: "Create trigger draft", onClick: onCreate }
                : undefined
            }
            imageSrc={HERO.sequences}
            imageAlt="A branching automation definition"
          />
        )
      ) : rows ? (
        <>
          <TriggerDefinitionsTable
            rows={rows}
            canAdmin={canAdmin}
            pollingId={pollingId}
            runtimeHelpId={runtimeHelpId}
            onSelect={onSelect}
            onEdit={onEdit}
            onDelete={onDelete}
            onPoll={onPoll}
          />
          <div className="automations-pagination" role="status">
            <span>
              {rows.length.toLocaleString()} definition
              {rows.length === 1 ? "" : "s"} loaded
              {list.totalEstimate !== null
                ? ` · approximately ${list.totalEstimate.toLocaleString()} available`
                : ""}
            </span>
            {list.nextCursor ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={list.loadingMore || list.refreshing}
                onClick={onLoadMore}
              >
                {list.loadingMore ? "Loading more…" : "Load more definitions"}
              </button>
            ) : (
              <span>End of available definitions</span>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}

function TriggerDefinitionsTable({
  rows,
  canAdmin,
  pollingId,
  runtimeHelpId,
  onSelect,
  onEdit,
  onDelete,
  onPoll,
}: {
  rows: ZeroCopyTrigger[];
  canAdmin: boolean;
  pollingId: string | null;
  runtimeHelpId: string;
  onSelect: (trigger: ZeroCopyTrigger) => void;
  onEdit: (trigger: ZeroCopyTrigger) => void;
  onDelete: (trigger: ZeroCopyTrigger) => void;
  onPoll: (trigger: ZeroCopyTrigger) => void;
}): ReactElement {
  return (
    <div
      className="automations-table-scroll"
      role="region"
      aria-label="Warehouse trigger definitions"
      tabIndex={0}
    >
      <table className="data-table automations-responsive-table">
        <caption className="visually-hidden">
          Stored warehouse trigger definitions. Enqueue totals are not journey
          execution or delivery receipts.
        </caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Provider</th>
            <th scope="col">Stored status</th>
            <th scope="col">Interval</th>
            <th scope="col">Enqueue rows</th>
            <th scope="col">Last poll record</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((trigger) => {
            const health = triggerHealth(trigger);
            const legacyActive = trigger.status.toLowerCase() === "active";
            return (
              <tr key={trigger.id}>
                <td data-label="Name">
                  <button
                    type="button"
                    className="link-button automations-name-button"
                    onClick={() => onSelect(trigger)}
                    aria-label={`Inspect stored definition for ${trigger.name}`}
                  >
                    {trigger.name}
                  </button>
                </td>
                <td data-label="Provider">
                  <code>{trigger.provider}</code>
                </td>
                <td data-label="Stored status">
                  <span
                    className={`badge ${legacyActive ? "warning" : health.tone === "neutral" ? "" : health.tone}`}
                  >
                    {legacyActive ? "active · runtime blocked" : health.label}
                  </span>
                </td>
                <td data-label="Interval" className="tabular">
                  {fmtDuration(trigger.polling_interval_seconds)}
                </td>
                <td data-label="Enqueue rows" className="tabular">
                  {trigger.rows_fired_total.toLocaleString()}
                </td>
                <td data-label="Last poll record" className="muted tabular">
                  {fmtRelative(trigger.last_polled_at)}
                </td>
                <td data-label="Actions">
                  <div className="automations-row-actions">
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onSelect(trigger)}
                    >
                      Inspect
                    </button>
                    {canAdmin ? (
                      <>
                        <button
                          type="button"
                          className="link-button"
                          aria-disabled="true"
                          aria-describedby={runtimeHelpId}
                          onClick={() => onPoll(trigger)}
                        >
                          {pollingId === trigger.id
                            ? "Polling…"
                            : "Poll unavailable"}
                        </button>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => onEdit(trigger)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="link-button danger"
                          onClick={() => onDelete(trigger)}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
