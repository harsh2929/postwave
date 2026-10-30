/**
 * SavedViewsBar — dropdown + Save/Delete affordances for the
 * named-filter-set surface above the audit list. Refined Audit PR 2.
 *
 * The bar shows three controls:
 *
 *   1. A `<select>` of existing views. Picking one calls onLoad with
 *      the view's filter blob; the page maps the blob back into its
 *      form state.
 *   2. "Save current" — opens a name/description prompt that
 *      snapshots the page's current filter set + posts to
 *      /audit/saved-views.
 *   3. "Delete" — only visible when a saved view is currently
 *      selected. Hard delete with a confirm.
 *
 * Lazy-loads the list on mount so the audit page footprint stays
 * the same when no views exist.
 */

import {
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { type AuditSavedView, api } from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";

interface Props {
  currentFilters: Record<string, unknown>;
  onLoad: (filters: Record<string, unknown>) => void;
  /** Server mutation policy: read-only auditors may load, but not create/delete. */
  canManage?: boolean;
}

export function SavedViewsBar({
  currentFilters,
  onLoad,
  canManage = false,
}: Props): ReactElement {
  const [views, setViews] = useState<AuditSavedView[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedID, setSelectedID] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const formId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const nameHintId = useId();
  const saveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  // Pending delete-saved-view confirmation. The legacy window.confirm
  // returned null in some Tauri builds and visually clashed with the
  // rest of the audit surface.
  const [deletePending, setDeletePending] = useState(false);
  const deleteOperation = useSingleFlightOperation({
    ownerId: "audit-saved-view-delete",
    label: "Saved audit view deletion",
    detail: "Wait for the saved-view deletion to finish before leaving.",
  });

  const load = async (): Promise<void> => {
    const res = await api.listAuditSavedViews();
    /* Defensive: a partial /audit/saved_views payload may omit `.views`.
     * Coerce to [] (not undefined) so the readers below stay safe.
     * When the endpoint errors (typically 500 in unwired envs), surface
     * "Saved views unavailable" instead of leaving the dropdown stuck
     * on the "Loading…" placeholder. */
    if (!res.error && res.data) {
      setViews(Array.isArray(res.data.views) ? res.data.views : []);
      setLoadErr(null);
    } else {
      setViews([]);
      setLoadErr(res.error?.message ?? "Failed to load");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onSave = async (): Promise<boolean> => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const res = await api.createAuditSavedView({
      name: trimmed,
      description,
      filters: currentFilters,
    });
    if (res.error) {
      toast.error(`Save failed: ${res.error.message}`);
      return false;
    }
    toast.success(`Saved view "${trimmed}"`);
    setSaving(false);
    queueMicrotask(() => saveTriggerRef.current?.focus());
    setName("");
    setDescription("");
    if (res.data) setSelectedID(res.data.id);
    void load();
    return true;
  };

  const createLifecycle = useDraftLifecycleController({
    ownerId: "audit-saved-view-create",
    label: "New saved audit view draft",
    mode: "create",
    enabled: saving,
    dirty: Boolean(name.trim()) || Boolean(description.trim()),
    save: onSave,
    discard: () => {
      setName("");
      setDescription("");
    },
    close: () => {
      setSaving(false);
      queueMicrotask(() => saveTriggerRef.current?.focus());
    },
    detail:
      "This named audit view has not been created. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the saved-view request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(error, "The saved view couldn't be created."),
      ),
  });

  const onDelete = (): void => {
    if (!selectedID) return;
    // Stage for ConfirmModal — confirmDelete() runs the API call.
    setDeletePending(true);
  };

  const onSaveFormKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (
      e.nativeEvent.isComposing ||
      e.nativeEvent.keyCode === 229 ||
      e.key !== "Escape"
    ) {
      return;
    }
    e.preventDefault();
    createLifecycle.requestClose();
  };

  const confirmDelete = async (): Promise<void> => {
    if (!selectedID) return;
    const v = views?.find((x) => x.id === selectedID);
    const targetID = selectedID;
    const request = deleteOperation.run(async () => {
      try {
        const res = await api.deleteAuditSavedView(targetID);
        if (res.error) {
          if (res.error.status === 404) {
            toast.error("That saved view is already gone — refreshing.");
            setDeletePending(false);
            void load();
            return;
          }
          toast.error(`Delete failed: ${res.error.message}`);
          return;
        }
        toast.success(`Deleted "${v?.name ?? targetID}"`);
        setSelectedID("");
        setDeletePending(false);
        void load();
      } catch (error) {
        toast.error(
          lifecycleOperationError(error, "The saved view couldn't be deleted."),
        );
      }
    });
    if (!request) await deleteOperation.wait();
  };

  const onPick = (id: string): void => {
    setSelectedID(id);
    const v = views?.find((x) => x.id === id);
    if (v) onLoad(v.filters);
  };

  useEffect(() => {
    if (!saving || createLifecycle.active) return;
    nameRef.current?.focus();
  }, [createLifecycle.active, saving]);

  return (
    <div className="audit-saved-views">
      <select
        className="input audit-saved-views-select"
        value={selectedID}
        disabled={createLifecycle.active || deleteOperation.active}
        onChange={(e) => onPick(e.target.value)}
        aria-label="Saved views"
      >
        <option value="">
          {views === null
            ? "Loading saved views…"
            : loadErr
              ? "Saved views unavailable"
              : (views ?? []).length === 0
                ? "No saved views"
                : "Load a saved view…"}
        </option>
        {views?.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      {canManage && selectedID ? (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={createLifecycle.active || deleteOperation.active}
          onClick={() => onDelete()}
        >
          Delete
        </button>
      ) : null}
      {canManage ? (
        <button
          ref={saveTriggerRef}
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={saving || createLifecycle.active || deleteOperation.active}
          onClick={() => setSaving(true)}
          aria-expanded={saving}
          aria-controls={formId}
        >
          + Save current
        </button>
      ) : null}
      {canManage && saving ? (
        <div
          id={formId}
          className="audit-saved-views-form"
          role="region"
          aria-label="Save current audit view"
        >
          <label className="sr-only" htmlFor={nameId}>
            Saved view name
          </label>
          <input
            ref={nameRef}
            id={nameId}
            className="input"
            style={{ fontSize: 12 }}
            placeholder="Name (e.g. SOC2 monthly)"
            maxLength={256}
            value={name}
            disabled={createLifecycle.active || deleteOperation.active}
            aria-describedby={!name.trim() ? nameHintId : undefined}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onSaveFormKeyDown}
          />
          <label className="sr-only" htmlFor={descriptionId}>
            Saved view description (optional)
          </label>
          <input
            id={descriptionId}
            className="input"
            style={{ fontSize: 12 }}
            placeholder="Description (optional)"
            maxLength={2048}
            value={description}
            disabled={createLifecycle.active || deleteOperation.active}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={onSaveFormKeyDown}
          />
          {!name.trim() ? (
            <span id={nameHintId} className="muted" style={{ fontSize: 11 }}>
              Enter a name to enable Save.
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void createLifecycle.submit()}
            onKeyDown={onSaveFormKeyDown}
            disabled={!name.trim() || createLifecycle.active}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={createLifecycle.requestClose}
            onKeyDown={onSaveFormKeyDown}
            disabled={createLifecycle.active}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {/* Delete-saved-view confirm. Replaces the legacy native confirm()
          so the destructive prompt matches the rest of the audit surface. */}
      <ConfirmModal
        open={canManage && deletePending}
        title="Delete saved view?"
        description={(() => {
          const v = views?.find((x) => x.id === selectedID);
          return `Delete saved view "${v?.name ?? selectedID}"? This only removes the named filter set; audit rows are untouched.`;
        })()}
        confirmLabel="Delete view"
        danger
        busy={deleteOperation.active}
        onConfirm={(): Promise<void> => confirmDelete()}
        onClose={(): void => {
          if (!deleteOperation.active) setDeletePending(false);
        }}
      />
      <ConfirmModal
        open={canManage && createLifecycle.discardConfirmOpen}
        title="Discard saved-view draft?"
        description="The named audit filter view has not been created."
        confirmLabel="Discard draft"
        danger
        busy={createLifecycle.active || deleteOperation.active}
        onConfirm={createLifecycle.discardAndClose}
        onClose={createLifecycle.keepEditing}
      />
    </div>
  );
}
