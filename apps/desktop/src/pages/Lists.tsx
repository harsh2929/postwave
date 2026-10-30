/**
 * Lists — audience containers (Listmonk-backed mailing lists).
 *
 * Layout follows the Subscribers exemplar:
 *   1. Page header with "New list" CTA.
 *   2. Search input + type filter chips.
 *   3. Table of lists (name / type / optin / subscribers / description).
 *   4. Inline row actions (rename / delete) — both go through a Modal.
 *   5. Create modal.
 *
 * Backend:  apps/api/internal/lists/lists.go (passthrough to Listmonk).
 * Endpoints: GET/POST /api/v1/lists, PATCH/DELETE /api/v1/lists/{id}.
 *
 * The Listmonk envelope is `{data:{results:[…]}}`; we still run the
 * standard `Array.isArray → items → results → data` defensive ladder so
 * the page survives backend rewrites.
 *
 * Full-surface wiring 2026-06 (#24): a "Growth sources" section below
 * the table reads /api/v1/growth-source/{summary,timeseries,quality}.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import { FieldError, FormField, useFormErrors } from "../components/FormField";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { HERO } from "../lib/heroAssets";
import { PageHeader } from "../components/PageHeader";
import { PendingSyncStatus } from "../components/PendingSyncStatus";

import { ConfirmModal } from "../components/ConfirmModal";
import { GrowthSourcesCard } from "../components/lists/GrowthSourcesCard";
import { ListDetailSlideover } from "../components/lists/ListDetailSlideover";
import { ListHealthBadge } from "../components/lists/ListHealthBadge";
import { ListsStatStrip } from "../components/lists/ListsStatStrip";
import { Modal, ModalFooter } from "../components/Modal";
import { toast } from "../components/Toast";
import { type List, type ListHealthResult, api } from "../lib/api-client";
import { queueReceiptMessage } from "../lib/api/result";
import { consumeDesktopTaskIntent } from "../lib/desktop-task-intents";
import {
  consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget,
} from "../lib/deep-link";
import { fmtDate } from "../lib/format-date";
import { useCanWrite } from "../lib/store";
import {
  type DraftLifecycleController,
  useDraftLifecycleController,
} from "../hooks/useDraftLifecycleController";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import { useWriteDesktopTaskIntent } from "../hooks/useDesktopTaskIntent";

type TypeFilter = "all" | "public" | "private";

const PAGE_SIZE = 25;
// 7 columns: name · type · optin · subscribers · health · description · actions
const COLS = "1.6fr 100px 110px 100px 70px 1.2fr 96px";

/** Map keyed by `listKey(row)` since List.id can be number|string. */
type HealthMap = Record<string, ListHealthResult | null>;

function listKey(row: List): string {
  return String(row.id ?? row.name ?? "");
}

function listToDraft(row: List): Draft {
  return {
    name: row.name ?? "",
    type:
      (row.type ?? "private").toLowerCase() === "public" ? "public" : "private",
    optin:
      (row.optin ?? "single").toLowerCase() === "double" ? "double" : "single",
    description: row.description ?? "",
  };
}

function typeBadge(type: string | undefined): ReactElement {
  const t = (type ?? "private").toLowerCase();
  if (t === "public") return <span className="badge accent">Public</span>;
  return <span className="badge">Private</span>;
}

function optinBadge(optin: string | undefined): ReactElement {
  const o = (optin ?? "single").toLowerCase();
  if (o === "double") return <span className="badge success">Double</span>;
  return <span className="badge">Single</span>;
}

interface Draft {
  name: string;
  type: "public" | "private";
  optin: "single" | "double";
  description: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  type: "private",
  optin: "single",
  description: "",
};

function useListCreateTaskRoute(
  open: boolean,
  canMutate: boolean,
  onOpen: () => void,
  setOpen: (open: boolean) => void,
  dirty: boolean,
  lifecycle: DraftLifecycleController,
) {
  useWriteDesktopTaskIntent({
    intent: "new-list",
    open,
    canMutate,
    onOpen,
    onRouteExit: () => setOpen(false),
  });
  return {
    requestClose: (): void => {
      const consume = !dirty && !lifecycle.active;
      lifecycle.requestClose();
      if (consume) consumeDesktopTaskIntent("new-list");
    },
    confirmDiscard: (): void => {
      if (lifecycle.active) return;
      lifecycle.discardAndClose();
      consumeDesktopTaskIntent("new-list");
    },
  };
}

function useListDeepLink(
  rows: List[] | null,
  setOpenList: (list: List | null) => void,
): void {
  const [pendingId, setPendingId] = useState<string | null>(null);
  useEffect(() => {
    const accept = (target: { section: string; id: string } | null): void => {
      if (target?.section === "lists" && target.id) setPendingId(target.id);
    };
    accept(consumePendingDeepLinkTarget());
    return onPendingDeepLinkTarget((target) => {
      if (target.section !== "lists") return;
      consumePendingDeepLinkTarget();
      accept(target);
    });
  }, []);
  useEffect(() => {
    if (!pendingId || !rows) return;
    setPendingId(null);
    const match = rows.find((row) => String(row.id) === pendingId);
    if (match) setOpenList(match);
    else toast.error("Couldn't find that list — it may have been deleted.");
  }, [pendingId, rows, setOpenList]);
}

function useListHealth(rows: List[] | null): HealthMap {
  const [healthByKey, setHealthByKey] = useState<HealthMap>({});
  useEffect(() => {
    if (!rows || rows.length === 0) return;
    let cancelled = false;
    const targets = rows.slice(0, 20);
    void Promise.all(
      targets.map(async (row) => {
        const key = listKey(row);
        if (!row.name) return [key, null] as const;
        const response = await api.getListHealth({
          tag: row.name,
          windowDays: 90,
        });
        const data = response.error ? null : (response.data ?? null);
        return [key, data && data.total_subscribers > 0 ? data : null] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setHealthByKey((current) => {
        const next = { ...current };
        for (const [key, value] of pairs) next[key] = value;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rows]);
  return healthByKey;
}

interface ListsTableProps {
  canMutate: boolean;
  filter: TypeFilter;
  healthByKey: HealthMap;
  loading: boolean;
  page: number;
  pageRows: List[];
  query: string;
  rows: List[] | null;
  totalPages: number;
  onCreate: () => void;
  onDelete: (list: List) => void;
  onEdit: (list: List) => void;
  onFilterChange: (filter: TypeFilter) => void;
  onOpen: (list: List) => void;
  onPageChange: (page: number) => void;
  onQueryChange: (query: string) => void;
}

function ListsTable({
  canMutate,
  filter,
  healthByKey,
  loading,
  page,
  pageRows,
  query,
  rows,
  totalPages,
  onCreate,
  onDelete,
  onEdit,
  onFilterChange,
  onOpen,
  onPageChange,
  onQueryChange,
}: ListsTableProps): ReactElement {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <input
          className="input"
          style={{ width: 280 }}
          placeholder="Search lists…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <div className="chips">
          {(["all", "public", "private"] as TypeFilter[]).map((option) => (
            <button
              key={option}
              type="button"
              className={`chip${filter === option ? " is-active" : ""}`}
              onClick={() => onFilterChange(option)}
            >
              {option[0]!.toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="list">
        <div className="list-header" style={{ gridTemplateColumns: COLS }}>
          <div>Name</div>
          <div>Type</div>
          <div>Opt-in</div>
          <div>Subscribers</div>
          <div>Health</div>
          <div>Description</div>
          <div></div>
        </div>
        {loading ? (
          <div style={{ padding: 12 }}>
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="skel-row" />
            ))}
          </div>
        ) : pageRows.length === 0 ? (
          query || filter !== "all" || (rows && rows.length > 0) ? (
            <div className="list-empty">
              <div className="empty-state">
                <div className="empty-state-icon">·</div>
                <h3>
                  {query ? `No matches for "${query}"` : "No lists match"}
                </h3>
                <p>
                  {query
                    ? "Clear the search to see all lists."
                    : "Try a different filter."}
                </p>
                {query ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onQueryChange("")}
                  >
                    Clear search
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <HeroEmptyState
              tone="mint"
              eyebrow="Segments"
              title="Group subscribers, send precisely."
              subtitle="Static lists for VIPs, dynamic lists that update as subscribers match your rules."
              primaryCta={
                canMutate ? { label: "New list", onClick: onCreate } : undefined
              }
              imageSrc={HERO.lists}
              imageAlt="Three stacks of bound index cards"
            />
          )
        ) : (
          pageRows.map((row, index) => {
            const key = listKey(row);
            const health = key in healthByKey ? healthByKey[key] : undefined;
            return (
              <div
                key={key || index}
                className="list-row"
                style={{ gridTemplateColumns: COLS }}
              >
                <div
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontWeight: 500,
                  }}
                  title={row.name}
                >
                  {row.name || <em className="muted">Unnamed list</em>}
                </div>
                <div>{typeBadge(row.type)}</div>
                <div>{optinBadge(row.optin)}</div>
                <div className="muted tabular">
                  {typeof row.subscriber_count === "number"
                    ? row.subscriber_count.toLocaleString()
                    : "—"}
                </div>
                <div>
                  <ListHealthBadge health={health} />
                </div>
                <div
                  className="muted"
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={row.description ?? ""}
                >
                  {row.description || (
                    <span className="subtle">{fmtDate(row.created_at)}</span>
                  )}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="list-row-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost list-row-action"
                      onClick={() => onOpen(row)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost list-row-action"
                      onClick={() => {
                        if (canMutate) onEdit(row);
                      }}
                      aria-disabled={!canMutate || undefined}
                      aria-describedby={
                        !canMutate ? "lists-write-permission" : undefined
                      }
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost list-row-action"
                      onClick={() => {
                        if (canMutate) onDelete(row);
                      }}
                      aria-disabled={!canMutate || undefined}
                      aria-describedby={
                        !canMutate ? "lists-write-permission" : undefined
                      }
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="pagination">
        <button
          type="button"
          className="btn btn-sm"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          Prev
        </button>
        <span>
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        >
          Next
        </button>
      </div>
    </>
  );
}

interface ListsPageViewProps extends ListsTableProps {
  createDraft: Draft;
  createLifecycle: DraftLifecycleController;
  createOpen: boolean;
  createSubmitErr: string | null;
  deleteBusy: boolean;
  deleteTarget: List | null;
  editDraft: Draft;
  editErr: string | null;
  editLifecycle: DraftLifecycleController;
  editTarget: List | null;
  err: string | null;
  formErrors: ReturnType<typeof useFormErrors>;
  openList: List | null;
  totalLabel: string;
  onCloseCreate: () => void;
  onCloseDelete: () => void;
  onCloseOpenList: () => void;
  onConfirmCreateDiscard: () => void;
  onCreateDraftChange: (draft: Draft) => void;
  onEditDraftChange: (draft: Draft) => void;
  onRefresh: () => void;
  onSubmitDelete: () => void;
}

function ListsPageView({
  canMutate,
  createDraft,
  createLifecycle,
  createOpen,
  createSubmitErr,
  deleteBusy,
  deleteTarget,
  editDraft,
  editErr,
  editLifecycle,
  editTarget,
  err,
  filter,
  formErrors,
  healthByKey,
  loading,
  openList,
  page,
  pageRows,
  query,
  rows,
  totalLabel,
  totalPages,
  onCloseCreate,
  onCloseDelete,
  onCloseOpenList,
  onConfirmCreateDiscard,
  onCreate,
  onCreateDraftChange,
  onDelete,
  onEdit,
  onEditDraftChange,
  onFilterChange,
  onOpen,
  onPageChange,
  onQueryChange,
  onRefresh,
  onSubmitDelete,
}: ListsPageViewProps): ReactElement {
  return (
    <>
      <PageHeader
        eyebrow="Audience"
        title="Lists"
        subtitle={totalLabel}
        actions={[
          {
            label: loading ? "Refreshing…" : "Refresh",
            onClick: onRefresh,
            disabled: loading,
          },
          {
            label: "New list",
            onClick: onCreate,
            variant: "primary",
            disabled: !canMutate,
            title: canMutate ? undefined : "Viewer role can't create lists",
          },
        ]}
      />
      <PendingSyncStatus resource="lists" />
      {!canMutate ? (
        <p
          id="lists-write-permission"
          className="muted"
          style={{ fontSize: 11, margin: "0 0 12px" }}
        >
          Viewer access is read-only; an editor or admin can create, edit, and
          delete lists.
        </p>
      ) : null}
      {rows && rows.length > 0 ? <ListsStatStrip rows={rows} /> : null}
      {err ? (
        <div className="notice">
          <span>Couldn&apos;t load lists: {err}</span>
        </div>
      ) : null}
      <ListsTable
        canMutate={canMutate}
        filter={filter}
        healthByKey={healthByKey}
        loading={loading}
        page={page}
        pageRows={pageRows}
        query={query}
        rows={rows}
        totalPages={totalPages}
        onCreate={onCreate}
        onDelete={onDelete}
        onEdit={onEdit}
        onFilterChange={onFilterChange}
        onOpen={onOpen}
        onPageChange={onPageChange}
        onQueryChange={onQueryChange}
      />
      <GrowthSourcesCard />
      <ListCreateModal
        open={createOpen}
        draft={createDraft}
        error={createSubmitErr}
        formErrors={formErrors}
        lifecycle={createLifecycle}
        onClose={onCloseCreate}
        onChange={onCreateDraftChange}
      />
      <ListEditModal
        open={editTarget !== null}
        draft={editDraft}
        error={editErr}
        lifecycle={editLifecycle}
        onChange={onEditDraftChange}
      />
      <ConfirmModal
        open={deleteTarget != null}
        title="Delete list"
        description={
          deleteTarget
            ? `Delete "${deleteTarget.name ?? "this list"}"? Subscriber records stay in the workspace, but every campaign / automation targeting this list will need to be re-pointed.`
            : ""
        }
        confirmLabel="Delete list"
        danger
        typeToConfirm={deleteTarget?.name?.trim() || undefined}
        busy={deleteBusy}
        onClose={onCloseDelete}
        onConfirm={onSubmitDelete}
      />
      <ConfirmModal
        open={createLifecycle.discardConfirmOpen}
        title="Discard list draft?"
        description="The list has not been created."
        confirmLabel="Discard draft"
        danger
        busy={createLifecycle.active}
        onConfirm={onConfirmCreateDiscard}
        onClose={createLifecycle.keepEditing}
      />
      <ConfirmModal
        open={editLifecycle.discardConfirmOpen}
        title="Discard list changes?"
        description="Your changes will be restored to the last loaded list."
        confirmLabel="Discard changes"
        danger
        busy={editLifecycle.active}
        onConfirm={editLifecycle.discardAndClose}
        onClose={editLifecycle.keepEditing}
      />
      {openList ? (
        <ListDetailSlideover
          list={openList}
          onClose={onCloseOpenList}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : null}
    </>
  );
}

export function Lists(): ReactElement {
  // Editor + admin can create / rename / delete; viewers see read-only.
  const canMutate = useCanWrite();
  const [rows, setRows] = useState<List[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TypeFilter>("all");
  const [page, setPage] = useState(1);

  // create
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const errors = useFormErrors();

  // edit
  const [editTarget, setEditTarget] = useState<List | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editErr, setEditErr] = useState<string | null>(null);

  // delete
  const [deleteTarget, setDeleteTarget] = useState<List | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteOperation = useSingleFlightOperation({
    ownerId: "list-delete",
    label: "List deletion",
    detail: "Wait for the list deletion request to finish before leaving.",
  });

  // detail slideover + per-list health cache.
  const [openList, setOpenList] = useState<List | null>(null);
  useListDeepLink(rows, setOpenList);
  const healthByKey = useListHealth(rows);

  const load = async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const res = await api.listLists();
    if (res.error) {
      setErr(res.error.message);
      setRows([]);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = res.data as any;
      // Listmonk's standard envelope is `{data:{results:[…]}}` — strip the
      // outer "data" wrapper before the usual defensive ladder so we don't
      // mistake the wrapper itself for the array.
      const inner = r?.data && !Array.isArray(r.data) ? r.data : r;
      const list = Array.isArray(inner)
        ? inner
        : (inner?.results ?? inner?.items ?? inner?.data ?? []);
      setRows(list as List[]);
    }
    setLoading(false);
  };

  useEffect(() => void load(), []);

  // The gateway now forwards `?query=` (and the legacy `?q=`) to
  // Listmonk's native query parameter — see apps/api/internal/lists.
  // The client-side filter below remains the default because the row
  // set is already small; callers wanting the server-side narrow can
  // use `listListsWithQuery({ query })` from api-client.
  const filtered = useMemo<List[]>(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all") {
        const t = (r.type ?? "private").toLowerCase();
        if (t !== filter) return false;
      }
      if (q) {
        const name = (r.name ?? "").toLowerCase();
        const desc = (r.description ?? "").toLowerCase();
        if (!name.includes(q) && !desc.includes(q)) return false;
      }
      return true;
    });
  }, [rows, query, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset to page 1 whenever the result set shrinks past current page.
  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);

  const openCreate = (): void => {
    setDraft(EMPTY_DRAFT);
    setSubmitErr(null);
    errors.clear();
    setCreateOpen(true);
  };

  const submitCreate = async (): Promise<boolean> => {
    const name = draft.name.trim();
    errors.clear();
    if (!name) {
      errors.set("name", "Name is required.");
      return false;
    }
    setSubmitErr(null);
    const res = await api.createList({
      name,
      type: draft.type,
      optin: draft.optin,
      description: draft.description.trim(),
    });
    if (res.error) {
      errors.set("_form", res.error.message);
      return false;
    }
    setCreateOpen(false);
    consumeDesktopTaskIntent("new-list");
    setDraft(EMPTY_DRAFT);
    if (res.queued) {
      toast.info({
        message: queueReceiptMessage(res.receipt),
        detail: `“${name}” will appear after the server confirms the create.`,
      });
      return true;
    }
    toast.success(`List "${name}" created`);
    void load();
    return true;
  };

  const openEdit = (row: List): void => {
    setEditTarget(row);
    setEditDraft(listToDraft(row));
    setEditErr(null);
  };

  const submitEdit = async (): Promise<boolean> => {
    if (!editTarget) return false;
    const target = editTarget;
    const name = editDraft.name.trim();
    if (!name) {
      setEditErr("Name is required.");
      return false;
    }
    setEditErr(null);
    const res = await api.updateList(target.id, {
      name,
      type: editDraft.type,
      optin: editDraft.optin,
      description: editDraft.description.trim(),
    });
    if (res.error) {
      setEditErr(res.error.message);
      return false;
    }
    setEditTarget(null);
    if (res.queued) {
      setRows(
        (current) =>
          current?.map((row) =>
            row.id === target.id
              ? {
                  ...row,
                  name,
                  type: editDraft.type,
                  optin: editDraft.optin,
                  description: editDraft.description.trim(),
                }
              : row,
          ) ?? current,
      );
      toast.info({
        message: queueReceiptMessage(res.receipt),
        detail: "The list shows your local edit until the server confirms it.",
      });
      return true;
    }
    toast.success(`List "${name}" updated`);
    void load();
    return true;
  };

  const createDraftDirty =
    JSON.stringify(draft) !== JSON.stringify(EMPTY_DRAFT);
  const createLifecycle = useDraftLifecycleController({
    ownerId: "list-create",
    label: "New list draft",
    mode: "create",
    enabled: createOpen,
    dirty: createDraftDirty,
    save: submitCreate,
    discard: () => {
      setDraft(EMPTY_DRAFT);
      setSubmitErr(null);
      errors.clear();
    },
    close: () => setCreateOpen(false),
    detail:
      "This list has not been created. Return to the form or explicitly discard it.",
    operationDetail:
      "Wait for the list creation request to finish before leaving.",
    onError: (error) =>
      errors.set(
        "_form",
        lifecycleOperationError(error, "The list couldn't be created."),
      ),
  });
  const createTaskRoute = useListCreateTaskRoute(
    createOpen,
    canMutate,
    openCreate,
    setCreateOpen,
    createDraftDirty,
    createLifecycle,
  );
  const editLifecycle = useDraftLifecycleController({
    ownerId: `list-edit-${String(editTarget?.id ?? "none")}`,
    label: "List changes",
    mode: "edit",
    enabled: editTarget !== null,
    dirty:
      editTarget !== null &&
      JSON.stringify(editDraft) !== JSON.stringify(listToDraft(editTarget)),
    save: submitEdit,
    discard: () => {
      if (editTarget) setEditDraft(listToDraft(editTarget));
      setEditErr(null);
    },
    close: () => setEditTarget(null),
    detail: "These list changes have not been saved.",
    operationDetail:
      "Wait for the list update request to finish before leaving.",
    onError: (error) =>
      setEditErr(
        lifecycleOperationError(error, "The list couldn't be updated."),
      ),
  });

  const submitDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const request = deleteOperation.run(async () => {
      setDeleting(true);
      try {
        const res = await api.deleteList(target.id);
        if (res.error) {
          toast.error({
            message: "Couldn't delete list",
            detail: res.error.message,
          });
          return;
        }
        setDeleteTarget(null);
        toast.success(`List "${target.name}" deleted`);
        void load();
      } catch (error) {
        toast.error({
          message: "Couldn't delete list",
          detail: lifecycleOperationError(error, "The delete request failed."),
        });
      } finally {
        setDeleting(false);
      }
    });
    if (!request) await deleteOperation.wait();
  };

  const totalLabel = rows
    ? `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} lists`
    : "Loading…";

  return (
    <ListsPageView
      canMutate={canMutate}
      createDraft={draft}
      createLifecycle={createLifecycle}
      createOpen={createOpen}
      createSubmitErr={submitErr}
      deleteBusy={deleting || deleteOperation.active}
      deleteTarget={deleteTarget}
      editDraft={editDraft}
      editErr={editErr}
      editLifecycle={editLifecycle}
      editTarget={editTarget}
      err={err}
      filter={filter}
      formErrors={errors}
      healthByKey={healthByKey}
      loading={loading}
      openList={openList}
      page={page}
      pageRows={pageRows}
      query={query}
      rows={rows}
      totalLabel={totalLabel}
      totalPages={totalPages}
      onCloseCreate={createTaskRoute.requestClose}
      onCloseDelete={() => {
        if (!deleteOperation.active) setDeleteTarget(null);
      }}
      onCloseOpenList={() => setOpenList(null)}
      onConfirmCreateDiscard={createTaskRoute.confirmDiscard}
      onCreate={openCreate}
      onCreateDraftChange={setDraft}
      onDelete={(list) => {
        setOpenList(null);
        setDeleteTarget(list);
      }}
      onEdit={(list) => {
        setOpenList(null);
        openEdit(list);
      }}
      onEditDraftChange={setEditDraft}
      onFilterChange={(nextFilter) => {
        setFilter(nextFilter);
        setPage(1);
      }}
      onOpen={setOpenList}
      onPageChange={setPage}
      onQueryChange={(nextQuery) => {
        setQuery(nextQuery);
        setPage(1);
      }}
      onRefresh={() => void load()}
      onSubmitDelete={() => void submitDelete()}
    />
  );
}

function ListCreateModal({
  open,
  draft,
  error,
  formErrors,
  lifecycle,
  onClose,
  onChange,
}: {
  open: boolean;
  draft: Draft;
  error: string | null;
  formErrors: ReturnType<typeof useFormErrors>;
  lifecycle: DraftLifecycleController;
  onClose: () => void;
  onChange: (draft: Draft) => void;
}): ReactElement {
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      title="New list"
      description="Lists group subscribers for campaigns and automations."
    >
      <FormField
        label="Name"
        required
        htmlFor="list-new-name"
        error={formErrors.get("name")}
      >
        <input
          id="list-new-name"
          className="input"
          placeholder="Weekly newsletter"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </FormField>
      <div className="row" style={{ gap: 8 }}>
        <FormField
          label="Visibility"
          htmlFor="list-new-type"
          helpTooltip="Private lists are admin-managed. Public lists appear on hosted preference pages."
        >
          <select
            id="list-new-type"
            className="input"
            value={draft.type}
            onChange={(event) =>
              onChange({
                ...draft,
                type: event.target.value as Draft["type"],
              })
            }
          >
            <option value="private">Private (recommended)</option>
            <option value="public">Public</option>
          </select>
        </FormField>
        <FormField
          label="Opt-in"
          htmlFor="list-new-optin"
          helpTooltip="Double opt-in sends a confirmation email before subscribing."
        >
          <select
            id="list-new-optin"
            className="input"
            value={draft.optin}
            onChange={(event) =>
              onChange({
                ...draft,
                optin: event.target.value as Draft["optin"],
              })
            }
          >
            <option value="single">Single</option>
            <option value="double">Double (confirmation email)</option>
          </select>
        </FormField>
      </div>
      <FormField label="Description" htmlFor="list-new-desc">
        <input
          id="list-new-desc"
          className="input"
          placeholder="Optional context shown in the dashboard"
          value={draft.description}
          onChange={(event) =>
            onChange({ ...draft, description: event.target.value })
          }
        />
      </FormField>
      {formErrors.get("_form") ? (
        <FieldError>{formErrors.get("_form")}</FieldError>
      ) : error ? (
        <div className="field-error">{error}</div>
      ) : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={lifecycle.active}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void lifecycle.submit()}
          disabled={lifecycle.active}
        >
          {lifecycle.active ? "Creating…" : "Create list"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function ListEditModal({
  open,
  draft,
  error,
  lifecycle,
  onChange,
}: {
  open: boolean;
  draft: Draft;
  error: string | null;
  lifecycle: DraftLifecycleController;
  onChange: (draft: Draft) => void;
}): ReactElement {
  return (
    <Modal
      open={open}
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      title="Edit list"
      description="Rename or change visibility. Subscribers are preserved."
    >
      <FormField label="Name" htmlFor="list-edit-name">
        <input
          id="list-edit-name"
          className="input"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </FormField>
      <div className="row" style={{ gap: 8 }}>
        <FormField label="Visibility" htmlFor="list-edit-type">
          <select
            id="list-edit-type"
            className="input"
            value={draft.type}
            onChange={(event) =>
              onChange({
                ...draft,
                type: event.target.value as Draft["type"],
              })
            }
          >
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
        </FormField>
        <FormField label="Opt-in" htmlFor="list-edit-optin">
          <select
            id="list-edit-optin"
            className="input"
            value={draft.optin}
            onChange={(event) =>
              onChange({
                ...draft,
                optin: event.target.value as Draft["optin"],
              })
            }
          >
            <option value="single">Single</option>
            <option value="double">Double</option>
          </select>
        </FormField>
      </div>
      <FormField label="Description" htmlFor="list-edit-desc">
        <input
          id="list-edit-desc"
          className="input"
          value={draft.description}
          onChange={(event) =>
            onChange({ ...draft, description: event.target.value })
          }
        />
      </FormField>
      {error ? <div className="field-error">{error}</div> : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={lifecycle.requestClose}
          disabled={lifecycle.active}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void lifecycle.submit()}
          disabled={lifecycle.active}
        >
          {lifecycle.active ? "Saving…" : "Save changes"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
