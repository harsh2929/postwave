/**
 * MergeFieldsTab — list-scoped custom subscriber fields.
 *
 * Wave-2 (GAP-LS-127/128/129 UI). Mirrors the Mailchimp/Klaviyo
 * "audience fields" concept: a typed schema attached to a list so
 * templates and forms can reference {{ merge_fields.TAG }}.
 *
 * Wire contract (apps/api/internal/lists/merge_fields.go):
 *   - rows are keyed by `tag` (uppercase A-Z0-9_, starts with a letter,
 *     max 10 chars) — there is no `id` on the wire;
 *   - GET returns `{list_id, merge_fields: [...]}`;
 *   - POST requires `tag`; PATCH/DELETE address the row by `{tag}` in
 *     the path.
 * CRUD via `listsMergeFieldsApi`.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type List,
  type ListMergeField,
  listsMergeFieldsApi,
} from "../../../lib/api-client";
import { useCanWrite } from "../../../lib/store";
import { ConfirmModal } from "../../ConfirmModal";
import { FormField } from "../../FormField";
import { Modal, ModalFooter } from "../../Modal";
import { toast } from "../../Toast";
import { usePersistentLifecycleOperation } from "../../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useExistingSettingLifecycle,
} from "../../../hooks/useSettingsDraftLifecycle";

interface Props {
  list: List;
}

type FieldType = ListMergeField["type"];

/**
 * Row shape per the server contract. Extends the api-client type so the
 * component compiles against both the legacy `{id}` typing and the
 * tag-keyed contract the Phase-B api-client update lands.
 */
type MergeFieldRow = Omit<ListMergeField, "id"> & {
  tag: string;
  help_text?: string;
};

const FIELD_TYPES: Array<{ value: FieldType; label: string; hint: string }> = [
  { value: "text", label: "Text", hint: "Single-line string" },
  { value: "number", label: "Number", hint: "Integer or decimal" },
  { value: "date", label: "Date", hint: "ISO 8601 date" },
  { value: "email", label: "Email", hint: "Validated email address" },
  { value: "phone", label: "Phone", hint: "E.164 format recommended" },
  { value: "address", label: "Address", hint: "Multi-line postal address" },
];

/** Server-side tag rules (merge_fields.go): uppercase snake, starts with
 *  a letter, max 10 chars. */
const TAG_MAX_LEN = 10;
const TAG_RE = /^[A-Z][A-Z0-9_]*$/;

/** Auto-suggest an uppercase-snake tag from a human field name, e.g.
 *  "First name" → "FIRST_NAME" (clamped to the 10-char server cap). */
function suggestTag(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^[^A-Z]+/, "") // must start with a letter
    .replace(/_+$/, "")
    .slice(0, TAG_MAX_LEN)
    .replace(/_+$/, "");
}

interface Draft {
  tag: string;
  name: string;
  type: FieldType;
  required: boolean;
  default_value: string;
}

const EMPTY_DRAFT: Draft = {
  tag: "",
  name: "",
  type: "text",
  required: false,
  default_value: "",
};

function draftFromField(field: MergeFieldRow): Draft {
  return {
    tag: field.tag,
    name: field.name,
    type: field.type,
    required: !!field.required,
    default_value: field.default_value ?? "",
  };
}

function draftsEqual(left: Draft, right: Draft): boolean {
  return (
    left.tag === right.tag &&
    left.name === right.name &&
    left.type === right.type &&
    left.required === right.required &&
    left.default_value === right.default_value
  );
}

export function MergeFieldsTab({ list }: Props): ReactElement {
  const mountedRef = useRef(true);
  const refreshSequenceRef = useRef(0);
  const baselineRef = useRef<Draft>({ ...EMPTY_DRAFT });
  const canMutate = useCanWrite();

  const [fields, setFields] = useState<MergeFieldRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MergeFieldRow | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // Once the operator edits the tag by hand we stop auto-suggesting from
  // the name so we don't clobber their input.
  const [tagTouched, setTagTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorErr, setEditorErr] = useState<string | null>(null);
  // Pending delete target. Replaces a native confirm() so destructive
  // prompts match the rest of the admin surface and work in Tauri.
  const [pendingDelete, setPendingDelete] = useState<MergeFieldRow | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const operation = usePersistentLifecycleOperation({
    ownerId: `list-merge-fields-${String(list.id)}`,
    label: "List merge-field operation",
  });
  const draftDirty = editorOpen && !draftsEqual(draft, baselineRef.current);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshSequenceRef.current += 1;
    };
  }, []);

  const discardEditorDraft = useCallback((): void => {
    setDraft({ ...baselineRef.current });
    setTagTouched(baselineRef.current.tag !== "");
    setEditorErr(null);
    setDiscardConfirmOpen(false);
    setEditorOpen(false);
  }, []);

  const refresh = async (): Promise<void> => {
    const requestId = ++refreshSequenceRef.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await listsMergeFieldsApi.list(list.id);
      if (!mountedRef.current || requestId !== refreshSequenceRef.current)
        return;
      if (res.error) {
        setErr(res.error.message);
        setFields([]);
      } else {
        const payload = res.data as unknown as
          | { merge_fields?: MergeFieldRow[]; items?: MergeFieldRow[] }
          | undefined;
        setFields(payload?.merge_fields ?? payload?.items ?? []);
      }
    } catch (error) {
      if (!mountedRef.current || requestId !== refreshSequenceRef.current)
        return;
      setErr(lifecycleOperationError(error, "Couldn't load merge fields."));
      setFields([]);
    } finally {
      if (mountedRef.current && requestId === refreshSequenceRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.id]);

  const openCreate = (): void => {
    baselineRef.current = { ...EMPTY_DRAFT };
    setEditing(null);
    setDraft({ ...EMPTY_DRAFT });
    setTagTouched(false);
    setEditorErr(null);
    setDiscardConfirmOpen(false);
    setEditorOpen(true);
  };

  const openEdit = (f: MergeFieldRow): void => {
    const baseline = draftFromField(f);
    baselineRef.current = baseline;
    setEditing(f);
    setDraft(baseline);
    setTagTouched(true);
    setEditorErr(null);
    setDiscardConfirmOpen(false);
    setEditorOpen(true);
  };

  const submit = async (): Promise<boolean> => {
    const name = draft.name.trim();
    if (!name) {
      setEditorErr("Name is required.");
      return false;
    }
    const tag = draft.tag.trim().toUpperCase();
    if (!editing) {
      if (!tag) {
        setEditorErr("Tag is required.");
        return false;
      }
      if (tag.length > TAG_MAX_LEN || !TAG_RE.test(tag)) {
        setEditorErr(
          `Tag must be 1–${TAG_MAX_LEN} uppercase letters, digits or underscores, starting with a letter.`,
        );
        return false;
      }
    }
    const editingTarget = editing;
    const submittedDraft: Draft = {
      ...draft,
      name,
      tag,
    };
    setSaving(true);
    setEditorErr(null);
    // Built as a variable (not an inline literal) so the extra `tag`
    // property is accepted by the pre-contract api-client signature.
    const body = {
      tag,
      name,
      type: draft.type,
      required: draft.required,
      default_value: draft.default_value || undefined,
    };
    const pending = operation.run(() =>
      editingTarget
        ? // Update/delete are keyed by the row's tag (path param).
          listsMergeFieldsApi.update(list.id, editingTarget.tag, body)
        : listsMergeFieldsApi.create(list.id, body),
    );
    if (!pending) {
      setSaving(false);
      return false;
    }
    try {
      const res = await pending;
      if (!mountedRef.current) return true;
      if (res.error) {
        setEditorErr(res.error.message);
        return false;
      }
      baselineRef.current = submittedDraft;
      setDraft(submittedDraft);
      setEditorOpen(false);
      setDiscardConfirmOpen(false);
      toast.success(
        editingTarget ? `Updated ${name}` : `Added merge field ${name}`,
      );
      void refresh();
      return true;
    } catch (error) {
      if (mountedRef.current) {
        setEditorErr(
          lifecycleOperationError(error, "The merge-field request failed."),
        );
      }
      return false;
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  useDiscardOnlyDraftLifecycle({
    ownerId: `list-merge-field-create-${String(list.id)}`,
    label: `New merge field for ${list.name}`,
    dirty: editing === null && draftDirty,
    operationRef: operation.promiseRef,
    discard: discardEditorDraft,
    enabled: editorOpen && editing === null,
    detail:
      "This merge-field schema draft has not been created. Return to it or explicitly discard it.",
  });
  useExistingSettingLifecycle({
    ownerId: `list-merge-field-${String(list.id)}-${editing?.tag ?? "none"}`,
    label: "Merge-field changes",
    dirty: editing !== null && draftDirty,
    operationRef: operation.promiseRef,
    save: submit,
    discard: discardEditorDraft,
    enabled: editorOpen && editing !== null,
  });

  const requestCloseEditor = (): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    setEditorOpen(false);
  };

  const remove = (f: MergeFieldRow): void => {
    // Stage for ConfirmModal — confirmRemove() runs the API call.
    setPendingDelete(f);
  };

  const confirmRemove = async (): Promise<void> => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleteBusy(true);
    const pending = operation.run(() =>
      listsMergeFieldsApi.remove(list.id, target.tag),
    );
    if (!pending) {
      setDeleteBusy(false);
      return;
    }
    try {
      const res = await pending;
      if (!mountedRef.current) return;
      if (res.error) {
        toast.error(`Couldn't delete: ${res.error.message}`);
        return;
      }
      toast.success(`Removed ${target.name}`);
      setPendingDelete(null);
      void refresh();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          `Couldn't delete: ${lifecycleOperationError(
            error,
            "The merge-field delete request failed.",
          )}`,
        );
      }
    } finally {
      if (mountedRef.current) setDeleteBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <MergeFieldsHeader
        listName={list.name}
        canMutate={canMutate}
        onCreate={openCreate}
      />

      {err ? (
        <div className="notice">
          <span>Couldn&apos;t load merge fields: {err}</span>
        </div>
      ) : null}

      {loading ? (
        <>
          <div className="skel-row" />
          <div className="skel-row" />
        </>
      ) : fields.length === 0 ? (
        <div className="pw-chart-empty">
          No merge fields defined yet. Add fields like <code>FNAME</code>,{" "}
          <code>COMPANY</code>, or <code>RENEWAL</code> to personalize sends.
        </div>
      ) : (
        <MergeFieldRows
          fields={fields}
          canMutate={canMutate}
          onEdit={openEdit}
          onRemove={remove}
        />
      )}

      <MergeFieldEditorOverlays
        open={editorOpen}
        editing={editing}
        draft={draft}
        setDraft={setDraft}
        tagTouched={tagTouched}
        setTagTouched={setTagTouched}
        saving={saving}
        error={editorErr}
        busy={operation.active}
        discardConfirmOpen={discardConfirmOpen}
        setDiscardConfirmOpen={setDiscardConfirmOpen}
        requestClose={requestCloseEditor}
        discard={discardEditorDraft}
        submit={submit}
      />

      {/* Delete-merge-field confirm. Replaces the legacy native confirm()
          so the destructive prompt matches the rest of the admin surface
          and works inside Tauri webviews. */}
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete merge field?"
        description={
          pendingDelete
            ? `Delete merge field "${pendingDelete.name}" (${pendingDelete.tag})? References in templates will render empty until you update them.`
            : ""
        }
        confirmLabel="Delete field"
        danger
        busy={deleteBusy || operation.active}
        onConfirm={(): Promise<void> => confirmRemove()}
        onClose={(): void => setPendingDelete(null)}
      />
    </div>
  );
}

function MergeFieldsHeader({
  listName,
  canMutate,
  onCreate,
}: {
  listName: string;
  canMutate: boolean;
  onCreate: () => void;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <div className="muted" style={{ fontSize: 12 }}>
        Custom fields attached to members of <code>{listName}</code>. Reference
        them in templates by tag as <code>{"{{ merge_fields.TAG }}"}</code>.
      </div>
      <span className="spacer" style={{ flex: 1 }} />
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={onCreate}
        disabled={!canMutate}
      >
        Add field
      </button>
    </div>
  );
}

function MergeFieldRows({
  fields,
  canMutate,
  onEdit,
  onRemove,
}: {
  fields: MergeFieldRow[];
  canMutate: boolean;
  onEdit: (field: MergeFieldRow) => void;
  onRemove: (field: MergeFieldRow) => void;
}): ReactElement {
  const columns = "110px 1fr 100px 80px 110px";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: columns,
          gap: 8,
          padding: "4px 10px",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "var(--pw-fg-subtle)",
        }}
      >
        <span>Tag</span>
        <span>Name</span>
        <span>Type</span>
        <span>Required</span>
        <span style={{ textAlign: "right" }}>Actions</span>
      </div>
      {fields.map((field) => (
        <div
          key={field.tag}
          style={{
            display: "grid",
            gridTemplateColumns: columns,
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
              fontFamily: "var(--pw-font-mono, monospace)",
            }}
            title={`{{ merge_fields.${field.tag} }}`}
          >
            {field.tag}
          </span>
          <span
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: "var(--pw-fg)",
            }}
            title={field.name}
          >
            {field.name}
          </span>
          <span className="muted" style={{ fontSize: 11 }}>
            {field.type}
          </span>
          <span style={{ fontSize: 11 }}>
            {field.required ? (
              <span className="badge warning">Required</span>
            ) : (
              <span className="muted">Optional</span>
            )}
          </span>
          <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onEdit(field)}
              disabled={!canMutate}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onRemove(field)}
              disabled={!canMutate}
              aria-label={`Delete ${field.name}`}
            >
              ×
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

function MergeFieldEditorOverlays({
  open,
  editing,
  draft,
  setDraft,
  tagTouched,
  setTagTouched,
  saving,
  error,
  busy,
  discardConfirmOpen,
  setDiscardConfirmOpen,
  requestClose,
  discard,
  submit,
}: {
  open: boolean;
  editing: MergeFieldRow | null;
  draft: Draft;
  setDraft: (draft: Draft | ((current: Draft) => Draft)) => void;
  tagTouched: boolean;
  setTagTouched: (touched: boolean) => void;
  saving: boolean;
  error: string | null;
  busy: boolean;
  discardConfirmOpen: boolean;
  setDiscardConfirmOpen: (open: boolean) => void;
  requestClose: () => void;
  discard: () => void;
  submit: () => Promise<boolean>;
}): ReactElement {
  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        closeOnBackdrop={!busy}
        closeOnEscape={!busy}
        closeDisabled={busy}
        title={editing ? `Edit ${editing.name}` : "Add merge field"}
        description="Merge fields define typed slots that templates and forms can reference."
      >
        <FormField label="Name" required htmlFor="mf-name">
          <input
            id="mf-name"
            className="input"
            placeholder="First name"
            value={draft.name}
            onChange={(event) => {
              const name = event.target.value;
              setDraft((current) => ({
                ...current,
                name,
                tag: !editing && !tagTouched ? suggestTag(name) : current.tag,
              }));
            }}
            spellCheck={false}
          />
        </FormField>
        <FormField
          label="Tag"
          required
          htmlFor="mf-tag"
          help={
            editing
              ? "Tags identify the field on the wire and can't be renamed."
              : `Uppercase letters, digits and underscores, max ${TAG_MAX_LEN} chars. Templates reference {{ merge_fields.TAG }}.`
          }
        >
          <input
            id="mf-tag"
            className="input"
            placeholder="FNAME"
            value={draft.tag}
            disabled={!!editing}
            maxLength={TAG_MAX_LEN}
            onChange={(event) => {
              setTagTouched(true);
              setDraft((current) => ({
                ...current,
                tag: event.target.value.toUpperCase(),
              }));
            }}
            spellCheck={false}
            style={{ fontFamily: "var(--pw-font-mono, monospace)" }}
          />
        </FormField>
        <FormField label="Type" required htmlFor="mf-type">
          <select
            id="mf-type"
            className="input"
            value={draft.type}
            onChange={(event) =>
              setDraft({ ...draft, type: event.target.value as FieldType })
            }
          >
            {FIELD_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label} — {type.hint}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Default value" htmlFor="mf-default">
          <input
            id="mf-default"
            className="input"
            value={draft.default_value}
            onChange={(event) =>
              setDraft({ ...draft, default_value: event.target.value })
            }
            placeholder="(optional)"
          />
        </FormField>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            marginTop: 8,
          }}
        >
          <input
            type="checkbox"
            checked={draft.required}
            onChange={(event) =>
              setDraft({ ...draft, required: event.target.checked })
            }
          />
          Required — forms must collect this field
        </label>
        {error ? (
          <div className="field-error" style={{ marginTop: 8 }}>
            {error}
          </div>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={requestClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={
              busy || !draft.name.trim() || (!editing && !draft.tag.trim())
            }
          >
            {saving ? "Saving…" : editing ? "Save changes" : "Add field"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title={
          editing
            ? "Discard merge-field changes?"
            : "Discard merge-field draft?"
        }
        description={
          editing
            ? "The unsaved name, type, default, or requirement changes will be lost."
            : "The merge-field name, tag, type, and default in this draft will be lost."
        }
        confirmLabel="Discard changes"
        danger
        busy={busy}
        onConfirm={discard}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}
