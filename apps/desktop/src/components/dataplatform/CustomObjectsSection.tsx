/**
 * Data Platform → Custom objects section (#36).
 *
 * Tenant-defined object types (CRUD; the properties editor round-trips
 * the validator's flat JSON-Schema subset — richer schemas fall back
 * to raw-JSON editing so constraints are never silently dropped) and a
 * records browser per type (list / upsert / delete; upserts key on
 * externalId, and 422 schema violations render field-by-field).
 *
 * NOTE: camelCase wire — types.go has camelCase json tags throughout.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { HeroEmptyState } from "../HeroEmptyState";
import { Icon } from "../Icon";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import {
  type CustomObjectRecord,
  type CustomObjectType,
  customObjectsApi,
} from "../../lib/api-client";
import { HERO } from "../../lib/heroAssets";
import { safeDataPlatformFailure } from "./safe-failures";

import {
  PROPERTY_TYPES,
  type PropertyType,
  type RecordViolation,
  type TypeDraft,
  parseJsonObject,
  propertiesPreview,
  recordViolations,
  typeDraftErrors,
  typeDraftFrom,
  typeDraftSchema,
} from "./custom-objects-helpers";

const TYPE_COLS = "1.2fr 1fr 1fr 110px 170px";
const RECORD_COLS = "1.2fr 2fr 170px 120px";

export function CustomObjectsSection({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const [types, setTypes] = useState<CustomObjectType[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [formTarget, setFormTarget] = useState<
    CustomObjectType | null | undefined
  >(undefined);
  const [deleting, setDeleting] = useState<CustomObjectType | null>(null);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const recordsPanelId = useId();
  const newTypeButtonRef = useRef<HTMLButtonElement | null>(null);
  const typeEditorReturnFocusRef = useRef<HTMLElement | null>(null);
  const typeDeleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const deleteOperation = useSingleFlightOperation({
    ownerId: "custom-object-type-delete",
    label: "Custom object type deletion",
    detail: "Wait for the object-type deletion to finish before leaving.",
  });
  const [browse, setBrowse] = useState<CustomObjectType | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current;
    setErr(null);
    let res;
    try {
      res = await customObjectsApi.listTypes();
    } catch {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setErr("Couldn't reach custom objects. Check the connection and retry.");
      return;
    }
    if (!mountedRef.current || requestId !== requestRef.current) return;
    if (res.error) {
      setErr(
        res.error.status === 404
          ? "Custom objects aren't enabled on this Moosewave server."
          : safeDataPlatformFailure(
              res.error,
              "Custom object types could not be verified.",
            ),
      );
      return;
    }
    setTypes(res.data?.items ?? []);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, [load]);

  const activeTypes = (types ?? []).filter((type) => type.status === "active");
  const schemaManagedTypes = (types ?? []).filter(
    (type) => Object.keys(type.schema ?? {}).length > 0,
  );

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    const target = deleting;
    const request = deleteOperation.run(async () => {
      try {
        const res = await customObjectsApi.deleteType(target.id, {
          expectedVersion: target.version,
          confirmationKey: target.key,
        });
        if (res.error) {
          toast.error({
            message: "Couldn't delete type",
            detail: safeDataPlatformFailure(
              res.error,
              "The custom-object service could not delete this type.",
            ),
          });
          return;
        }
        toast.success(`Deleted "${target.label}"`);
        typeDeleteReturnFocusRef.current = newTypeButtonRef.current;
        if (browse?.id === target.id) setBrowse(null);
        setDeleting(null);
        void load();
      } catch (error) {
        toast.error({
          message: "Couldn't delete type",
          detail: safeDataPlatformFailure(error, "The delete request failed."),
        });
      }
    });
    if (!request) await deleteOperation.wait();
  };

  return (
    <div className="dp-section dp-custom-objects">
      <SectionHeader
        title="Object types"
        description="Tenant-defined data shapes with versioned schemas. Record creates and edits are bound to exact loaded versions."
        actions={
          canAdmin ? (
            <button
              ref={newTypeButtonRef}
              type="button"
              className="btn btn-sm btn-primary"
              onClick={(event) => {
                typeEditorReturnFocusRef.current = event.currentTarget;
                setFormTarget(null);
              }}
            >
              + New type
            </button>
          ) : undefined
        }
      />

      {types !== null ? (
        <div className="dp-operation-strip" aria-label="Custom object summary">
          <div>
            <span>Object types</span>
            <strong className="tabular">{types.length.toLocaleString()}</strong>
            <small>{activeTypes.length.toLocaleString()} active</small>
          </div>
          <div>
            <span>Schema governed</span>
            <strong className="tabular">
              {schemaManagedTypes.length.toLocaleString()}
            </strong>
            <small>Validated on every write</small>
          </div>
          <div>
            <span>Record inspector</span>
            <strong>{browse?.label ?? "No type selected"}</strong>
            <small>Conflict-safe exact-version writes</small>
          </div>
        </div>
      ) : null}

      {err ? (
        <Notice
          className="dp-notice"
          tone="danger"
          announcement="assertive"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void load();
              }}
            >
              Retry object types
            </button>
          }
        >
          {err}
        </Notice>
      ) : null}

      {types === null ? (
        err ? null : (
          <p className="muted">Loading types…</p>
        )
      ) : types.length === 0 ? (
        <HeroEmptyState
          tone="sand"
          eyebrow="Data platform"
          title="Model your business objects next to your subscribers."
          subtitle="Define a type once — orders, bookings, wishlists — then upsert records by external id and use them in segments and flows. The schema validates every write."
          imageSrc={HERO.assets}
          imageAlt="Organized shelves representing structured records"
          primaryCta={
            canAdmin
              ? {
                  label: "New type",
                  onClick: () => {
                    typeEditorReturnFocusRef.current = newTypeButtonRef.current;
                    setFormTarget(null);
                  },
                }
              : undefined
          }
        />
      ) : (
        <div
          className="list dp-data-list dp-object-type-list"
          role="table"
          aria-label="Custom object types"
          aria-rowcount={types.length + 1}
        >
          <div role="rowgroup">
            <div
              className="list-header"
              role="row"
              style={{ gridTemplateColumns: TYPE_COLS }}
            >
              <div role="columnheader">Label</div>
              <div role="columnheader">Key</div>
              <div role="columnheader">Primary key</div>
              <div role="columnheader">Status</div>
              <div role="columnheader">Actions</div>
            </div>
          </div>
          <div role="rowgroup">
            {types.map((t) => (
              <ObjectTypeRow
                key={t.id}
                objType={t}
                canAdmin={canAdmin}
                browsing={browse?.id === t.id}
                recordsPanelId={recordsPanelId}
                onToggleRecords={() =>
                  setBrowse(browse?.id === t.id ? null : t)
                }
                onEdit={(trigger) => {
                  typeEditorReturnFocusRef.current = trigger;
                  setFormTarget(t);
                }}
                onDelete={(trigger) => {
                  typeDeleteReturnFocusRef.current = trigger;
                  setDeleting(t);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {browse ? (
        <RecordsBrowser
          key={browse.id}
          id={recordsPanelId}
          objType={browse}
          canAdmin={canAdmin}
        />
      ) : null}

      {formTarget !== undefined ? (
        <TypeEditorModal
          key={formTarget?.id ?? "create"}
          existing={formTarget}
          returnFocusRef={typeEditorReturnFocusRef}
          onClose={() => setFormTarget(undefined)}
          onSaved={() => {
            setFormTarget(undefined);
            void load();
          }}
        />
      ) : null}

      <ConfirmModal
        open={deleting !== null}
        danger
        title={`Delete type "${deleting?.label ?? ""}"?`}
        description="Its records go with it, and segments or flows referencing this type's key will stop matching. This can't be undone."
        confirmLabel="Delete type"
        typeToConfirm={deleting?.key ?? undefined}
        busy={deleteOperation.active}
        returnFocusRef={typeDeleteReturnFocusRef}
        onConfirm={() => void confirmDelete()}
        onClose={() => (deleteOperation.active ? undefined : setDeleting(null))}
      />
    </div>
  );
}

function ObjectTypeRow({
  objType,
  canAdmin,
  browsing,
  recordsPanelId,
  onToggleRecords,
  onEdit,
  onDelete,
}: {
  objType: CustomObjectType;
  canAdmin: boolean;
  browsing: boolean;
  recordsPanelId: string;
  onToggleRecords: () => void;
  onEdit: (trigger: HTMLButtonElement) => void;
  onDelete: (trigger: HTMLButtonElement) => void;
}): ReactElement {
  return (
    <div
      className="list-row"
      role="row"
      style={{ gridTemplateColumns: TYPE_COLS }}
    >
      <div role="cell" data-label="Label" style={{ fontWeight: 500 }}>
        {objType.label}
      </div>
      <div role="cell" className="mono muted" data-label="Key">
        {objType.key}
      </div>
      <div role="cell" className="mono muted" data-label="Primary key">
        {objType.primaryKey || "external_id"}
      </div>
      <div role="cell" data-label="Status">
        <span
          className={`badge${objType.status === "active" ? " success" : ""}`}
        >
          {objType.status}
        </span>
      </div>
      <div
        role="cell"
        data-label="Actions"
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 6,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-expanded={browsing}
          aria-controls={browsing ? recordsPanelId : undefined}
          onClick={onToggleRecords}
        >
          {browsing ? "Hide records" : "Records"}
        </button>
        {canAdmin ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label={`Edit ${objType.label}`}
              onClick={(event) => onEdit(event.currentTarget)}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label={`Delete ${objType.label}`}
              onClick={(event) => onDelete(event.currentTarget)}
            >
              Delete
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ---------- type editor (properties rows or raw JSON) ---------- */

function TypeEditorModal({
  existing,
  returnFocusRef,
  onClose,
  onSaved,
}: {
  existing: CustomObjectType | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const mode = existing ? "edit" : "create";
  const [draft, setDraft] = useState<TypeDraft>(() => typeDraftFrom(existing));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const patch = (p: Partial<TypeDraft>): void =>
    setDraft((d) => ({ ...d, ...p }));

  const patchRow = (
    i: number,
    p: Partial<{ name: string; type: PropertyType; required: boolean }>,
  ): void => {
    setDraft((d) => ({
      ...d,
      rows: d.rows.map((r, j) => (j === i ? { ...r, ...p } : r)),
    }));
  };

  const save = async (): Promise<boolean> => {
    const e = typeDraftErrors(draft, mode);
    setErrors(e);
    if (Object.keys(e).length > 0) return false;
    const schema = typeDraftSchema(draft);
    const res = existing
      ? await customObjectsApi.updateType(existing.id, {
          label: draft.label.trim(),
          schema,
          status: draft.status,
          expectedVersion: existing.version,
        })
      : await customObjectsApi.createType({
          key: draft.key.trim(),
          label: draft.label.trim(),
          ...(draft.primaryKey.trim()
            ? { primaryKey: draft.primaryKey.trim() }
            : {}),
          schema,
        });
    if (res.error) {
      setErrors({
        form: safeDataPlatformFailure(
          res.error,
          "The custom-object service could not save this type.",
        ),
      });
      return false;
    }
    toast.success(
      existing
        ? `Updated "${draft.label.trim()}"`
        : `Created "${draft.label.trim()}"`,
    );
    onSaved();
    return true;
  };

  const baseline = typeDraftFrom(existing);
  const lifecycle = useDraftLifecycleController({
    ownerId: existing
      ? `custom-object-type-edit-${existing.id}`
      : "custom-object-type-create",
    label: existing ? "Custom object type changes" : "New custom object type",
    mode: existing ? "edit" : "create",
    enabled: true,
    dirty: JSON.stringify(draft) !== JSON.stringify(baseline),
    save,
    discard: () => {
      setDraft(baseline);
      setErrors({});
    },
    close: onClose,
    detail: existing
      ? "These custom-object schema changes have not been saved."
      : "This custom-object type has not been created. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the custom-object type request to finish before leaving Moosewave.",
    onError: (error) =>
      setErrors({
        form: safeDataPlatformFailure(
          error,
          "The custom-object type couldn't be saved.",
        ),
      }),
  });

  return (
    <Modal
      open
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      returnFocusRef={returnFocusRef}
      size="lg"
      title={
        mode === "create"
          ? "New object type"
          : `Edit ${existing?.label ?? "type"}`
      }
      description="The schema validates every record write. Leave properties empty to accept anything."
    >
      <form
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void lifecycle.submit();
        }}
      >
        <fieldset
          disabled={lifecycle.active}
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          {errors.form ? (
            <Notice
              tone="danger"
              announcement="assertive"
              style={{ marginBottom: 12 }}
            >
              {errors.form}
            </Notice>
          ) : null}

          <div className="dp-form-grid dp-form-grid-2">
            <FormField
              label="Key"
              required={mode === "create"}
              error={errors.key}
              help={
                mode === "edit"
                  ? "Keys are immutable — segments and flows reference them."
                  : 'Machine name, e.g. "order".'
              }
            >
              <input
                type="text"
                value={draft.key}
                disabled={mode === "edit"}
                onChange={(e) => patch({ key: e.target.value })}
                placeholder="order"
              />
            </FormField>
            <FormField label="Label" required error={errors.label}>
              <input
                type="text"
                value={draft.label}
                onChange={(e) => patch({ label: e.target.value })}
                placeholder="Order"
              />
            </FormField>
          </div>

          {mode === "create" ? (
            <FormField
              label="Primary key property (optional)"
              help='Which property is the natural id. Defaults to "external_id".'
            >
              <input
                type="text"
                value={draft.primaryKey}
                onChange={(e) => patch({ primaryKey: e.target.value })}
                placeholder="external_id"
              />
            </FormField>
          ) : (
            <FormField label="Status">
              <select
                value={draft.status}
                onChange={(e) =>
                  patch({
                    status: e.target.value as TypeDraft["status"],
                  })
                }
              >
                <option value="active">active</option>
                <option value="deprecated">deprecated</option>
                <option value="disabled">disabled</option>
              </select>
            </FormField>
          )}

          {draft.rawSchemaText != null ? (
            <div className="dp-raw-schema-editor">
              <div className="dp-editor-mode" role="note">
                <Icon name="shield-check" size={17} />
                <div>
                  <strong>Full-fidelity schema mode</strong>
                  <span>
                    Nested or constrained schema detected. JSON editing
                    preserves every rule the row editor cannot represent.
                  </span>
                </div>
              </div>
              <FormField
                label="Schema (JSON)"
                error={errors.schema}
                help="This type's schema uses constraints (enum, min/max, nesting) the row editor can't represent — edit the JSON directly so nothing is dropped."
              >
                <textarea
                  className="mono dp-code-editor"
                  rows={12}
                  spellCheck={false}
                  value={draft.rawSchemaText}
                  onChange={(e) => patch({ rawSchemaText: e.target.value })}
                />
              </FormField>
            </div>
          ) : (
            <FormField label="Properties" error={errors.schema}>
              <div className="dp-schema-builder">
                {draft.rows.length === 0 ? (
                  <div className="dp-schema-empty">
                    No property rules yet. Records will accept any JSON object.
                  </div>
                ) : null}
                {draft.rows.map((r, i) => (
                  <div key={i} className="dp-schema-row">
                    <input
                      type="text"
                      aria-label={`Property ${i + 1} name`}
                      value={r.name}
                      onChange={(e) => patchRow(i, { name: e.target.value })}
                      placeholder="property_name"
                    />
                    <select
                      aria-label={`Property ${i + 1} type`}
                      value={r.type}
                      onChange={(e) =>
                        patchRow(i, { type: e.target.value as PropertyType })
                      }
                    >
                      {PROPERTY_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <label className="dp-inline-check">
                      <input
                        type="checkbox"
                        checked={r.required}
                        onChange={(e) =>
                          patchRow(i, { required: e.target.checked })
                        }
                      />
                      required
                    </label>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      aria-label={`Remove property ${i + 1}`}
                      onClick={() =>
                        patch({ rows: draft.rows.filter((_, j) => j !== i) })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div className="dp-schema-builder-footer">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      patch({
                        rows: [
                          ...draft.rows,
                          { name: "", type: "string", required: false },
                        ],
                      })
                    }
                  >
                    + Add property
                  </button>
                </div>
              </div>
            </FormField>
          )}

          <TypeEditorFooter
            active={lifecycle.active}
            mode={mode}
            onCancel={lifecycle.requestClose}
          />
        </fieldset>
      </form>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title={existing ? "Discard type changes?" : "Discard type draft?"}
        description={
          existing
            ? "The object schema will be restored to its loaded value."
            : "The custom-object type has not been created."
        }
        confirmLabel="Discard"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </Modal>
  );
}

function TypeEditorFooter({
  active,
  mode,
  onCancel,
}: {
  active: boolean;
  mode: "create" | "edit";
  onCancel: () => void;
}): ReactElement {
  return (
    <ModalFooter>
      <button
        type="button"
        className="btn"
        disabled={active}
        onClick={onCancel}
      >
        Cancel
      </button>
      <button type="submit" className="btn btn-primary" disabled={active}>
        {active
          ? "Saving…"
          : mode === "create"
            ? "Create type"
            : "Save changes"}
      </button>
    </ModalFooter>
  );
}

/* ---------- records browser ---------- */

function RecordsBrowser({
  id,
  objType,
  canAdmin,
}: {
  id: string;
  objType: CustomObjectType;
  canAdmin: boolean;
}): ReactElement {
  const [records, setRecords] = useState<CustomObjectRecord[] | null>(null);
  const [recordPageHasMore, setRecordPageHasMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterKeyDraft, setFilterKeyDraft] = useState("");
  const [filterValueDraft, setFilterValueDraft] = useState("");
  const [filterError, setFilterError] = useState<string | null>(null);
  const [appliedFilter, setAppliedFilter] = useState({ key: "", value: "" });
  const [editorTarget, setEditorTarget] = useState<
    CustomObjectRecord | null | undefined
  >(undefined);
  const [deleting, setDeleting] = useState<CustomObjectRecord | null>(null);
  const [viewing, setViewing] = useState<CustomObjectRecord | null>(null);
  const inspectTriggerRef = useRef<HTMLElement | null>(null);
  const upsertButtonRef = useRef<HTMLButtonElement | null>(null);
  const upsertReturnFocusRef = useRef<HTMLElement | null>(null);
  const recordDeleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const deleteOperation = useSingleFlightOperation({
    ownerId: `custom-object-record-delete-${objType.id}`,
    label: "Custom object record deletion",
    detail: "Wait for the object-record deletion to finish before leaving.",
  });

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current;
    setErr(null);
    setLoading(true);
    let res;
    try {
      res = await customObjectsApi.listRecords(objType.id, {
        ...(appliedFilter.key && appliedFilter.value
          ? {
              propertyKey: appliedFilter.key,
              propertyValue: appliedFilter.value,
            }
          : {}),
        limit: 100,
      });
    } catch {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setErr("Couldn't reach object records. Check the connection and retry.");
      setLoading(false);
      return;
    }
    if (!mountedRef.current || requestId !== requestRef.current) return;
    setLoading(false);
    if (res.error) {
      setErr(
        safeDataPlatformFailure(
          res.error,
          "Custom object records could not be verified.",
        ),
      );
      return;
    }
    setRecords(res.data?.items ?? []);
    setRecordPageHasMore(res.data?.hasMore === true);
  }, [appliedFilter.key, appliedFilter.value, objType.id]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, [load]);

  const applyFilter = (): void => {
    const key = filterKeyDraft.trim();
    const value = filterValueDraft.trim();
    if (Boolean(key) !== Boolean(value)) {
      setFilterError("Enter both a property key and a value.");
      return;
    }
    setFilterError(null);
    setRecords(null);
    if (key === appliedFilter.key && value === appliedFilter.value) {
      void load();
      return;
    }
    setAppliedFilter({ key, value });
  };

  const clearFilter = (): void => {
    setFilterKeyDraft("");
    setFilterValueDraft("");
    setFilterError(null);
    setRecords(null);
    if (!appliedFilter.key && !appliedFilter.value) {
      void load();
      return;
    }
    setAppliedFilter({ key: "", value: "" });
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    const target = deleting;
    const request = deleteOperation.run(async () => {
      try {
        const res = await customObjectsApi.deleteRecord(target.id, {
          expectedVersion: target.version,
          confirmationExternalId: target.externalId,
        });
        if (res.error) {
          toast.error({
            message: "Couldn't delete record",
            detail: safeDataPlatformFailure(
              res.error,
              "The custom-object service could not delete this record.",
            ),
          });
          return;
        }
        toast.success(`Deleted record ${target.externalId}`);
        recordDeleteReturnFocusRef.current = upsertButtonRef.current;
        setDeleting(null);
        void load();
      } catch (error) {
        toast.error({
          message: "Couldn't delete record",
          detail: safeDataPlatformFailure(error, "The delete request failed."),
        });
      }
    });
    if (!request) await deleteOperation.wait();
  };

  return (
    <section
      id={id}
      className="card dp-record-browser"
      aria-label={`${objType.label} records`}
    >
      <RecordsBrowserHeader
        objType={objType}
        canAdmin={canAdmin && objType.status !== "disabled"}
        createButtonRef={upsertButtonRef}
        onCreate={(trigger) => {
          upsertReturnFocusRef.current = trigger;
          setEditorTarget(null);
        }}
      />

      <RecordsFilter
        keyDraft={filterKeyDraft}
        valueDraft={filterValueDraft}
        hasAppliedFilter={Boolean(appliedFilter.key)}
        error={filterError}
        loading={loading}
        onKeyDraftChange={setFilterKeyDraft}
        onValueDraftChange={setFilterValueDraft}
        onApply={applyFilter}
        onClear={clearFilter}
      />

      {err ? (
        <RecordsLoadFailure error={err} onRetry={() => void load()} />
      ) : null}
      {records === null ? (
        err ? (
          <p className="muted">
            No verified record page is available. Retry when the service is
            reachable.
          </p>
        ) : (
          <p className="muted" role="status" aria-busy="true">
            Loading records…
          </p>
        )
      ) : (
        <>
          <div className="dp-list-summary" role="status">
            <span>
              Showing {records.length.toLocaleString()} record
              {records.length === 1 ? "" : "s"}
              {appliedFilter.key
                ? ` where ${appliedFilter.key} equals ${appliedFilter.value}`
                : ""}
            </span>
            {recordPageHasMore ? (
              <span>More records exist · first 100 shown</span>
            ) : null}
          </div>
          <div
            className="list dp-data-list dp-record-list"
            role="table"
            aria-label={`${objType.label} record directory`}
            aria-rowcount={records.length === 0 ? 2 : records.length + 1}
          >
            <div role="rowgroup">
              <div
                className="list-header"
                role="row"
                style={{ gridTemplateColumns: RECORD_COLS }}
              >
                <div role="columnheader">External id</div>
                <div role="columnheader">Properties</div>
                <div role="columnheader">Updated</div>
                <div role="columnheader">Actions</div>
              </div>
            </div>
            <div role="rowgroup">
              {records.length === 0 ? (
                <div className="list-empty" role="row">
                  <div role="cell" aria-colspan={4}>
                    <div className="empty-state">
                      <div className="empty-state-icon">·</div>
                      <h3>
                        {appliedFilter.key
                          ? "No records match this filter"
                          : "No records yet"}
                      </h3>
                      <p>
                        {appliedFilter.key
                          ? "Clear the property filter to see all records."
                          : canAdmin
                            ? "Create the first record here, or POST records through the API / warehouse import."
                            : "Records arrive via the API or warehouse imports."}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                records.map((r) => (
                  <RecordDirectoryRow
                    key={r.id}
                    record={r}
                    canAdmin={canAdmin}
                    onInspect={(trigger) => {
                      inspectTriggerRef.current = trigger;
                      setViewing(r);
                    }}
                    onEdit={
                      objType.status === "disabled"
                        ? undefined
                        : (trigger) => {
                            upsertReturnFocusRef.current = trigger;
                            setEditorTarget(r);
                          }
                    }
                    onDelete={(trigger) => {
                      recordDeleteReturnFocusRef.current = trigger;
                      setDeleting(r);
                    }}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}

      {editorTarget !== undefined ? (
        <RecordUpsertModal
          key={editorTarget?.id ?? "create"}
          objType={objType}
          existing={editorTarget}
          returnFocusRef={upsertReturnFocusRef}
          onClose={() => setEditorTarget(undefined)}
          onSaved={() => {
            setEditorTarget(undefined);
            void load();
          }}
        />
      ) : null}

      <RecordInspectorModal
        record={viewing}
        objType={objType}
        returnFocusRef={inspectTriggerRef}
        onClose={() => setViewing(null)}
      />

      <ConfirmModal
        open={deleting !== null}
        danger
        title={`Delete record "${deleting?.externalId ?? ""}"?`}
        description="The record is removed; a later upsert with the same external id recreates it fresh."
        confirmLabel="Delete record"
        busy={deleteOperation.active}
        returnFocusRef={recordDeleteReturnFocusRef}
        onConfirm={() => void confirmDelete()}
        onClose={() => (deleteOperation.active ? undefined : setDeleting(null))}
      />
    </section>
  );
}

function RecordDirectoryRow({
  record,
  canAdmin,
  onInspect,
  onEdit,
  onDelete,
}: {
  record: CustomObjectRecord;
  canAdmin: boolean;
  onInspect: (trigger: HTMLButtonElement) => void;
  onEdit?: (trigger: HTMLButtonElement) => void;
  onDelete: (trigger: HTMLButtonElement) => void;
}): ReactElement {
  return (
    <div
      className="list-row"
      role="row"
      style={{ gridTemplateColumns: RECORD_COLS, cursor: "default" }}
    >
      <div role="cell" className="mono" data-label="External ID">
        {record.externalId}
      </div>
      <div
        role="cell"
        className="muted mono"
        data-label="Properties"
        style={{
          fontSize: 11,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {propertiesPreview(record.properties)}
      </div>
      <div role="cell" className="muted tabular" data-label="Updated">
        {new Date(record.updatedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </div>
      <div
        role="cell"
        className="dp-row-actions"
        data-label="Actions"
        style={{ textAlign: "right" }}
      >
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-label={`Inspect record ${record.externalId}`}
          onClick={(event) => onInspect(event.currentTarget)}
        >
          Inspect
        </button>
        {canAdmin ? (
          <>
            {onEdit ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={`Edit record ${record.externalId}`}
                onClick={(event) => onEdit(event.currentTarget)}
              >
                Edit
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label={`Delete record ${record.externalId}`}
              onClick={(event) => onDelete(event.currentTarget)}
            >
              Delete
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function RecordsLoadFailure({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <Notice
      className="dp-notice"
      tone="danger"
      announcement="assertive"
      action={
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry records
        </button>
      }
    >
      Couldn&apos;t load records: {error}
    </Notice>
  );
}

function RecordsBrowserHeader({
  objType,
  canAdmin,
  createButtonRef,
  onCreate,
}: {
  objType: CustomObjectType;
  canAdmin: boolean;
  createButtonRef: RefObject<HTMLButtonElement | null>;
  onCreate: (trigger: HTMLButtonElement) => void;
}): ReactElement {
  return (
    <SectionHeader
      title={`Records — ${objType.label}`}
      description="Creates and exact-version edits are conflict-safe. Exact property filters are sent in a request body, never a URL."
      actions={
        canAdmin ? (
          <button
            ref={createButtonRef}
            type="button"
            className="btn btn-sm btn-primary"
            onClick={(event) => onCreate(event.currentTarget)}
          >
            + New record
          </button>
        ) : undefined
      }
    />
  );
}

function RecordsFilter({
  keyDraft,
  valueDraft,
  hasAppliedFilter,
  error,
  loading,
  onKeyDraftChange,
  onValueDraftChange,
  onApply,
  onClear,
}: {
  keyDraft: string;
  valueDraft: string;
  hasAppliedFilter: boolean;
  error: string | null;
  loading: boolean;
  onKeyDraftChange: (value: string) => void;
  onValueDraftChange: (value: string) => void;
  onApply: () => void;
  onClear: () => void;
}): ReactElement {
  return (
    <form
      className="dp-record-filter"
      aria-label="Filter object records"
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
    >
      <div className="dp-record-filter-fields">
        <label>
          <span>Property key</span>
          <input
            className="input mono"
            placeholder="status"
            value={keyDraft}
            onChange={(event) => onKeyDraftChange(event.target.value)}
          />
        </label>
        <span className="dp-record-filter-operator" aria-hidden="true">
          equals
        </span>
        <label>
          <span>Exact value</span>
          <input
            className="input"
            placeholder="completed"
            value={valueDraft}
            onChange={(event) => onValueDraftChange(event.target.value)}
          />
        </label>
      </div>
      <div className="dp-record-filter-actions">
        <button type="submit" className="btn btn-sm" disabled={loading}>
          {loading ? "Filtering…" : "Apply filter"}
        </button>
        {keyDraft || valueDraft || hasAppliedFilter ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onClear}
          >
            Clear
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="dp-field-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="dp-record-filter-help">
        Filtering runs only when submitted; typing never sends a request.
      </p>
    </form>
  );
}

function RecordInspectorModal({
  record,
  objType,
  returnFocusRef,
  onClose,
}: {
  record: CustomObjectRecord | null;
  objType: CustomObjectType;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): ReactElement | null {
  if (!record) return null;
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Record ${record.externalId}`}
      description={`${objType.label} · read-only properties from the currently loaded result.`}
      returnFocusRef={returnFocusRef}
    >
      <div className="dp-record-inspector-meta">
        <span>
          <strong>Created</strong>
          {new Date(record.createdAt).toLocaleString()}
        </span>
        <span>
          <strong>Updated</strong>
          {new Date(record.updatedAt).toLocaleString()}
        </span>
      </div>
      <div className="label">Properties</div>
      <pre className="mono dp-json-output">
        {JSON.stringify(record.properties, null, 2)}
      </pre>
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}

function RecordUpsertModal({
  objType,
  existing,
  returnFocusRef,
  onClose,
  onSaved,
}: {
  objType: CustomObjectType;
  existing: CustomObjectRecord | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const initialExternalID = existing?.externalId ?? "";
  const initialProperties = existing
    ? JSON.stringify(existing.properties, null, 2)
    : "{\n  \n}";
  const [externalId, setExternalId] = useState(initialExternalID);
  const [propsText, setPropsText] = useState(initialProperties);
  const [err, setErr] = useState<string | null>(null);
  const [violations, setViolations] = useState<RecordViolation[]>([]);

  const save = async (): Promise<boolean> => {
    setViolations([]);
    if (!externalId.trim()) {
      setErr("External id is required — it's the upsert key");
      return false;
    }
    const parsed = parseJsonObject(propsText);
    if (parsed.error || parsed.value === null) {
      setErr(parsed.error ?? "Properties must be a JSON object");
      return false;
    }
    setErr(null);
    const res = await customObjectsApi.upsertRecord(objType.id, {
      externalId: externalId.trim(),
      properties: parsed.value,
      expectedVersion: existing?.version ?? 0,
    });
    if (res.error) {
      // 422 schema violations arrive in the lifted error details.
      const v = recordViolations(res.error.details);
      if (v.length > 0) {
        setViolations(v);
        setErr("The record failed the type's schema:");
        return false;
      }
      setErr(
        safeDataPlatformFailure(
          res.error,
          existing
            ? "The custom-object service could not update this record version."
            : "The custom-object service could not create this record.",
        ),
      );
      return false;
    }
    toast.success(
      existing
        ? `Record ${externalId.trim()} updated`
        : `Record ${externalId.trim()} created`,
    );
    onSaved();
    return true;
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: existing
      ? `custom-object-record-edit-${existing.id}`
      : `custom-object-record-create-${objType.id}`,
    label: existing
      ? "Custom object record changes"
      : "New custom object record",
    mode: existing ? "edit" : "action",
    enabled: true,
    dirty: externalId !== initialExternalID || propsText !== initialProperties,
    save,
    discard: () => {
      setExternalId(initialExternalID);
      setPropsText(initialProperties);
      setErr(null);
      setViolations([]);
    },
    close: onClose,
    detail: existing
      ? "These custom-object record changes have not been saved."
      : "This custom-object record has not been created. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the custom-object record request to finish before leaving Moosewave.",
    onError: (error) =>
      setErr(
        safeDataPlatformFailure(
          error,
          existing
            ? "The record couldn't be updated."
            : "The record couldn't be created.",
        ),
      ),
  });

  return (
    <Modal
      open
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      returnFocusRef={returnFocusRef}
      size="lg"
      title={
        existing
          ? `Edit ${objType.label} record`
          : `New ${objType.label} record`
      }
      description={
        existing
          ? "The external ID is immutable; saving replaces the exact loaded record version after schema validation."
          : "Creation is conflict-safe and validates against the current type schema."
      }
    >
      <form
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void lifecycle.submit();
        }}
      >
        <fieldset
          disabled={lifecycle.active}
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          <FormField label="External id" required>
            <input
              type="text"
              value={externalId}
              disabled={Boolean(existing)}
              onChange={(e) => setExternalId(e.target.value)}
              placeholder="order_1001"
            />
          </FormField>
          <FormField label="Properties (JSON)" error={err}>
            <textarea
              className="mono dp-code-editor"
              rows={12}
              spellCheck={false}
              value={propsText}
              onChange={(e) => setPropsText(e.target.value)}
            />
          </FormField>
          {violations.length > 0 ? (
            <div className="dp-violation-list" role="alert">
              {violations.map((v, i) => (
                <div key={i}>
                  <Icon name="x" size={13} />
                  <span className="mono">{v.field || "(root)"}</span> —{" "}
                  {v.message}
                  {v.code ? <span className="muted"> [{v.code}]</span> : null}
                </div>
              ))}
            </div>
          ) : null}
          <ModalFooter>
            <button
              type="button"
              className="btn"
              disabled={lifecycle.active}
              onClick={lifecycle.requestClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={lifecycle.active}
            >
              {lifecycle.active
                ? "Saving…"
                : existing
                  ? "Save record"
                  : "Create record"}
            </button>
          </ModalFooter>
        </fieldset>
      </form>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title={existing ? "Discard record changes?" : "Discard new record?"}
        description={
          existing
            ? "The loaded record remains unchanged."
            : "No custom-object record has been created."
        }
        confirmLabel="Discard draft"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </Modal>
  );
}
