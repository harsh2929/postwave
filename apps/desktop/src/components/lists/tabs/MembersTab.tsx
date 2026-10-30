/**
 * MembersTab — paginated members of one list.
 *
 * Wave-1 (GAP-LS-042 + GAP-LS-050): replaces the best-effort
 * "subscribers whose tags match list name" preview with a real
 * server-paginated list backed by `listsExtendedApi.members`
 * (GET /api/v1/lists/{id}/subscribers).
 *
 * Wave-2: membership editing is live — the per-row Remove action goes
 * through a ConfirmModal into DELETE /api/v1/lists/{id}/subscribers/
 * {sub_id}, and the Add-subscribers picker bulk-adds via
 * POST /api/v1/lists/{id}/subscribers, reporting the server's
 * `{added, skipped}` counts verbatim. Errors surface as toasts with
 * the server message — no fake-success states.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  api,
  type List,
  type ListMember,
  listsExtendedApi,
} from "../../../lib/api-client";
import { fmtDate } from "../../../lib/format-date";
import { useCanAdmin } from "../../../lib/store";
import { ConfirmModal } from "../../ConfirmModal";
import { Modal, ModalFooter } from "../../Modal";
import { toast } from "../../Toast";
import { usePersistentLifecycleOperation } from "../../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../../../hooks/useSettingsDraftLifecycle";
import { addMembersToastCopy } from "./members-copy";

const PAGE_SIZE = 25;

type StatusFilter =
  | "all"
  | "enabled"
  | "disabled"
  | "blocklisted"
  | "unconfirmed";

interface Props {
  list: List;
  /** Bubble the server-side total up so the tab strip can render it. */
  onTotalChange?: (total: number) => void;
}

function statusBadge(status: string | undefined): ReactElement {
  const s = (status ?? "").toLowerCase();
  if (s === "blocklisted")
    return <span className="badge danger">Blocklisted</span>;
  if (s === "disabled") return <span className="badge warning">Disabled</span>;
  if (s === "unconfirmed")
    return <span className="badge warning">Unconfirmed</span>;
  if (s === "enabled") return <span className="badge success">Enabled</span>;
  return <span className="badge">{status ?? "—"}</span>;
}

export function MembersTab({ list, onTotalChange }: Props): ReactElement {
  const canAdmin = useCanAdmin();
  const permissionReasonId = useId();

  const [members, setMembers] = useState<ListMember[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /** Bumped after a successful mutation to refetch the current page. */
  const [refreshTick, setRefreshTick] = useState(0);

  // Add-subscribers picker.
  const [addOpen, setAddOpen] = useState(false);

  // Remove-member confirm.
  const [removeTarget, setRemoveTarget] = useState<ListMember | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  // 220ms debounce mirrors Subscribers/Suppressions search inputs.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    setPage(1);
  }, [debounced, status]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await listsExtendedApi.members(list.id, {
        page,
        perPage: PAGE_SIZE,
        query: debounced || undefined,
        status: status === "all" ? undefined : status,
      });
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message);
        setMembers([]);
        setTotal(0);
      } else {
        setMembers(res.data?.items ?? []);
        setTotal(res.data?.total ?? 0);
        onTotalChange?.(res.data?.total ?? 0);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [list.id, page, debounced, status, onTotalChange, refreshTick]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const confirmRemove = async (): Promise<void> => {
    if (!removeTarget) return;
    setRemoveBusy(true);
    const res = await listsExtendedApi.removeMember(list.id, removeTarget.id);
    setRemoveBusy(false);
    if (res.error) {
      // Keep the modal open so the operator can retry or cancel.
      toast.error({
        message: "Couldn't remove member",
        detail: `${removeTarget.email}: ${res.error.message}`,
      });
      return;
    }
    toast.success({
      message: "Removed from list",
      detail: `${removeTarget.email} is no longer on ${list.name}.`,
    });
    setRemoveTarget(null);
    // If that was the last row on a page > 1 step back a page,
    // otherwise refetch the current one (both update the total).
    if (members.length === 1 && page > 1) {
      setPage((p) => Math.max(1, p - 1));
    } else {
      setRefreshTick((t) => t + 1);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Toolbar: search + status filter + add CTA */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          className="input"
          style={{ width: 220 }}
          placeholder="Search members…"
          aria-label="Search members"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="input"
          style={{ width: 140 }}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="blocklisted">Blocklisted</option>
          <option value="unconfirmed">Unconfirmed</option>
        </select>
        <span className="spacer" style={{ flex: 1 }} />
        {!canAdmin ? (
          <span
            id={permissionReasonId}
            className="muted"
            style={{ fontSize: 11 }}
          >
            Admin role required to change list membership.
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            if (!canAdmin) return;
            setAddOpen(true);
          }}
          aria-disabled={!canAdmin || undefined}
          aria-describedby={!canAdmin ? permissionReasonId : undefined}
        >
          Add subscribers
        </button>
      </div>

      {err ? (
        <div className="notice">
          <span>Couldn&apos;t load members: {err}</span>
        </div>
      ) : null}

      {/* Members list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {loading ? (
          <>
            <div className="skel-row" />
            <div className="skel-row" />
            <div className="skel-row" />
          </>
        ) : members.length === 0 ? (
          <div className="pw-chart-empty">
            {debounced || status !== "all"
              ? "No members match the current filter."
              : "No subscribers in this list yet."}
          </div>
        ) : (
          members.map((m) => (
            <div
              key={m.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 100px 100px 80px",
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
                title={m.email}
              >
                {m.email}
              </span>
              <span style={{ textAlign: "left" }}>{statusBadge(m.status)}</span>
              <span
                className="muted tabular"
                style={{ fontSize: 10, textAlign: "right" }}
                title={m.added_at}
              >
                {fmtDate(m.added_at)}
              </span>
              <span style={{ textAlign: "right" }}>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    if (!canAdmin) return;
                    setRemoveTarget(m);
                  }}
                  aria-disabled={!canAdmin || undefined}
                  aria-describedby={!canAdmin ? permissionReasonId : undefined}
                  aria-label={`Remove ${m.email} from ${list.name}`}
                >
                  Remove
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE ? (
        <div className="pagination">
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <span>
            Page {page} of {totalPages} · {total.toLocaleString()} member
            {total === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </button>
        </div>
      ) : (
        <div
          className="muted"
          style={{ fontSize: 11, textAlign: "right", paddingRight: 4 }}
        >
          {total.toLocaleString()} member{total === 1 ? "" : "s"}
        </div>
      )}

      <ConfirmModal
        open={removeTarget != null}
        title="Remove from list?"
        description={
          removeTarget
            ? `${removeTarget.email} will be removed from ${list.name}. The subscriber record itself is kept.`
            : undefined
        }
        confirmLabel="Remove"
        danger
        busy={removeBusy}
        onConfirm={() => void confirmRemove()}
        onClose={() => (removeBusy ? undefined : setRemoveTarget(null))}
      />

      <AddSubscribersModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        list={list}
        onAdded={() => setRefreshTick((t) => t + 1)}
      />
    </div>
  );
}

/* ---------- add-subscribers picker -------------------------------- */

interface AddProps {
  open: boolean;
  onClose: () => void;
  list: List;
  /** Fired after a successful add so the parent can refetch members. */
  onAdded: () => void;
}

/**
 * AddSubscribersModal — searchable subscriber picker.
 *
 * Uses the existing `api.listSubscribers` search to find candidates;
 * confirming bulk-adds the selection via
 * POST /api/v1/lists/{id}/subscribers. The success toast reports the
 * server's `{added, skipped}` counts verbatim (skipped = already
 * members / suppressed / unknown ids); failures keep the modal open
 * and surface the server error.
 */
function AddSubscribersModal({
  open,
  onClose,
  list,
  onAdded,
}: AddProps): ReactElement {
  const mountedRef = useRef(true);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<
    Array<{ id: string; email: string; status?: string }>
  >([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const operation = usePersistentLifecycleOperation({
    ownerId: `list-members-add-${String(list.id)}`,
    label: "List member addition",
  });
  const draftDirty = query !== "" || selected.size > 0;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const discardDraft = useCallback((): void => {
    setQuery("");
    setDebounced("");
    setSelected(new Set());
    setResults([]);
    setDiscardConfirmOpen(false);
  }, []);

  useDiscardOnlyDraftLifecycle({
    ownerId: `list-members-add-${String(list.id)}`,
    label: `Add members to ${list.name}`,
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    enabled: open || draftDirty,
    detail:
      "This member search or selection has not been submitted. Return to it or explicitly discard it.",
  });

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api.listSubscribers({
          query: debounced || undefined,
          perPage: 20,
        });
        if (cancelled) return;
        if (!res.error) {
          const rows =
            res.data?.items ?? res.data?.results ?? res.data?.data ?? [];
          setResults(
            rows.flatMap((row) =>
              row.id == null
                ? []
                : [
                    {
                      id: String(row.id),
                      email: row.email,
                      status: row.status,
                    },
                  ],
            ),
          );
        } else {
          setResults([]);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, debounced]);

  const toggle = (id: string): void => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const submit = async (): Promise<void> => {
    const submittedIds = [...selected];
    const pending = operation.run(() =>
      listsExtendedApi.addMembers(list.id, submittedIds),
    );
    if (!pending) return;
    try {
      const res = await pending;
      if (!mountedRef.current) return;
      if (res.error) {
        // Keep the modal (and the selection) open so the operator can
        // retry without re-picking.
        toast.error({
          message: "Couldn't add subscribers",
          detail: res.error.message,
        });
        return;
      }
      const result = res.data ?? { added: 0, skipped: 0 };
      const copy = addMembersToastCopy(list.name, result);
      if (result.added > 0) toast.success(copy);
      else toast.info(copy);
      if (result.added > 0) {
        try {
          onAdded();
        } catch (refreshError) {
          toast.error({
            message: "Members added, but the list couldn't refresh",
            detail: lifecycleOperationError(
              refreshError,
              "Refresh the member list to see the saved change.",
            ),
          });
        }
      }
      discardDraft();
      onClose();
    } catch (error) {
      if (mountedRef.current) {
        toast.error({
          message: "Couldn't add subscribers",
          detail: lifecycleOperationError(
            error,
            "The member-add request failed.",
          ),
        });
      }
    }
  };

  const requestClose = (): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  };

  const discardAndClose = (): void => {
    if (operation.promiseRef.current) return;
    discardDraft();
    onClose();
  };

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        closeOnBackdrop={!operation.active}
        closeOnEscape={!operation.active}
        closeDisabled={operation.active}
        title={`Add subscribers to ${list.name}`}
        description="Search subscribers by email or name and pick the ones to add."
      >
        <input
          className="input"
          placeholder="Search subscribers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ marginBottom: 8 }}
        />
        <div
          style={{
            maxHeight: 320,
            overflowY: "auto",
            border: "1px solid var(--pw-border)",
            borderRadius: 4,
          }}
        >
          {loading ? (
            <div className="muted" style={{ padding: 12, fontSize: 12 }}>
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div className="muted" style={{ padding: 12, fontSize: 12 }}>
              {debounced
                ? `No subscribers match "${debounced}".`
                : "Start typing to find subscribers."}
            </div>
          ) : (
            results.map((r) => (
              <label
                key={r.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "20px 1fr auto",
                  gap: 8,
                  alignItems: "center",
                  padding: "6px 10px",
                  cursor: "pointer",
                  fontSize: 12,
                  borderBottom: "1px solid var(--pw-border)",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggle(r.id)}
                  disabled={operation.active}
                />
                <span
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={r.email}
                >
                  {r.email}
                </span>
                <span className="muted" style={{ fontSize: 10 }}>
                  {r.status ?? "—"}
                </span>
              </label>
            ))
          )}
        </div>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={requestClose}
            disabled={operation.active}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.size === 0 || operation.active}
            onClick={() => void submit()}
          >
            {operation.active
              ? "Adding…"
              : `Add ${selected.size > 0 ? `(${selected.size})` : ""}`}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard member selection?"
        description="The current subscriber search and selected members will be lost."
        confirmLabel="Discard selection"
        danger
        busy={operation.active}
        onConfirm={discardAndClose}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}
