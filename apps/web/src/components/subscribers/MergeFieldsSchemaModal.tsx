// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Audience-field (merge-field) schema editor — parity row audience-44; desktop
 * reference components/subscribers/MergeFieldsSchemaModal.
 *
 * /developer-reference listed the schema and nothing could change it. This
 * adds desktop's editor: create a field, patch its label / type / default /
 * order / required flag, remove it, and a discard guard before unsaved edits
 * are thrown away.
 *
 * THE SCHEMA IS PRODUCTION DATA. Edits stay local until a row is explicitly
 * saved; a field holding subscriber values has its type and deletion locked,
 * mirroring the server's fail-closed data-loss rules; and a PATCH sends only
 * what changed, so saving a label can never re-assert a stale type.
 *
 * The writes are ScopeWriteSubscribers: owners, admins AND editors may use
 * them, viewers (and View-as-viewer) may not. The role is re-read against the
 * live session immediately before each write.
 */

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import {
  effectiveAuthRole,
  whoamiFresh,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";
import {
  createMergeField,
  deleteMergeField,
  getMergeFieldSchema,
  MERGE_FIELD_KEY_PATTERN,
  MERGE_FIELD_MAX_LABEL,
  MERGE_FIELD_TYPE_COPY,
  MERGE_FIELD_TYPES,
  parseMergeFieldSchemaRows,
  patchMergeField,
  validateMergeFieldDefault,
  validateMergeFieldLabel,
  validateMergeFieldPosition,
  type MergeFieldSchemaPatch,
  type MergeFieldSchemaRow,
  type MergeFieldType,
} from "@/lib/developer-reference-api";
import { STALE } from "@/lib/query-keys";

const FIELD_WRITE_ROLES: readonly AuthRole[] = ["owner", "admin", "editor"];

/** Owner, admin or editor outside viewer mode — ScopeWriteSubscribers. */
export function canEditAudienceFields(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    FIELD_WRITE_ROLES.includes(effectiveAuthRole(identity)),
  );
}

/** Re-read the live session: same workspace, user, role and mode, still allowed. */
async function verifyFreshFieldAuthority(opened: MeResponse): Promise<void> {
  const fresh = await whoamiFresh();
  if (
    fresh.user_id !== opened.user_id ||
    fresh.tenant_id !== opened.tenant_id ||
    effectiveAuthRole(fresh) !== effectiveAuthRole(opened) ||
    Boolean(fresh.viewer_mode) !== Boolean(opened.viewer_mode)
  ) {
    throw new Error(
      "Workspace identity or authority changed. Nothing was written; reload and retry.",
    );
  }
  if (!canEditAudienceFields(fresh)) {
    throw new Error("Owner, admin, or editor access is required.");
  }
}

interface FieldDraft {
  label: string;
  type: MergeFieldType;
  default_value: string;
  required: boolean;
  /** Kept as typed so "-" or "" do not snap to 0 mid-edit. */
  position: string;
}

function draftFromRow(row: MergeFieldSchemaRow): FieldDraft {
  return {
    label: row.label,
    type: row.type,
    default_value: row.default_value,
    required: row.required,
    position: String(row.position),
  };
}

function parsePosition(value: string): number {
  return value.trim() === "" ? NaN : Number(value);
}

/** Only what changed — an absent field is left untouched server-side. */
function patchFor(row: MergeFieldSchemaRow, draft: FieldDraft): MergeFieldSchemaPatch {
  const patch: MergeFieldSchemaPatch = {};
  if (draft.label.trim() !== row.label) patch.label = draft.label.trim();
  if (draft.type !== row.type) patch.type = draft.type;
  if (draft.default_value.trim() !== row.default_value) {
    patch.default_value = draft.default_value.trim();
  }
  if (draft.required !== row.required) patch.required = draft.required;
  const position = parsePosition(draft.position);
  if (position !== row.position) patch.position = position;
  return patch;
}

function draftErrors(draft: FieldDraft) {
  return {
    label: validateMergeFieldLabel(draft.label),
    default_value: validateMergeFieldDefault(draft.type, draft.default_value),
    position: validateMergeFieldPosition(parsePosition(draft.position)),
  };
}

const EMPTY_NEW_FIELD = {
  key: "",
  label: "",
  type: "text" as MergeFieldType,
  default_value: "",
  required: false,
  position: "0",
};

/** Launcher placed under the read-only schema list. */
export function MergeFieldsSchemaEditor({
  identity,
  queryKey,
}: {
  identity: MeResponse | null;
  /** The page's merge-field key, so the reference list updates on save. */
  queryKey: readonly unknown[];
}) {
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const canEdit = canEditAudienceFields(identity);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canEdit}
        aria-describedby={canEdit ? undefined : reasonId}
        onClick={() => setOpen(true)}
      >
        <Pencil aria-hidden className="h-4 w-4" />
        Edit audience fields
      </Button>
      {!canEdit ? (
        <p id={reasonId} role="status" className="text-xs text-muted-foreground">
          {identity?.viewer_mode === true
            ? "View as viewer is on, so the audience-field schema is read-only."
            : "Editing audience fields needs owner, admin, or editor access."}
        </p>
      ) : null}
      {open && identity ? (
        <MergeFieldsSchemaModal
          identity={identity}
          queryKey={queryKey}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function MergeFieldsSchemaModal({
  identity,
  queryKey,
  onClose,
}: {
  identity: MeResponse;
  queryKey: readonly unknown[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const baseId = useId();
  const schema = useQuery({
    queryKey: [...queryKey],
    queryFn: getMergeFieldSchema,
    staleTime: STALE.reference,
  });
  const parsed = schema.isSuccess ? parseMergeFieldSchemaRows(schema.data) : null;
  const rows = parsed && "rows" in parsed ? parsed.rows : [];
  const contractError = parsed && "error" in parsed ? parsed.error : null;
  const schemaAvailable = parsed !== null && contractError === null;

  const [edits, setEdits] = useState<Record<string, FieldDraft>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newField, setNewField] = useState(EMPTY_NEW_FIELD);
  const [discardOpen, setDiscardOpen] = useState(false);

  const dirtyKeys = rows
    .filter((row) => {
      const draft = edits[row.key];
      return draft ? Object.keys(patchFor(row, draft)).length > 0 : false;
    })
    .map((row) => row.key);
  const newFieldDirty =
    JSON.stringify(newField) !== JSON.stringify(EMPTY_NEW_FIELD);
  const hasUnsaved = dirtyKeys.length > 0 || newFieldDirty;
  const busy = creating || savingKey !== null || deletingKey !== null;

  const writeRows = (next: (rows: unknown[]) => unknown[]) => {
    queryClient.setQueryData<unknown[]>([...queryKey], (current) =>
      next(Array.isArray(current) ? current : []),
    );
    void queryClient.invalidateQueries({ queryKey: [...queryKey] });
  };
  const forget = (key: string) => {
    setEdits(({ [key]: _dropped, ...rest }) => rest);
    setRowErrors(({ [key]: _dropped, ...rest }) => rest);
  };

  const requestClose = () => {
    if (busy) return;
    if (hasUnsaved) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };

  async function saveRow(row: MergeFieldSchemaRow) {
    const draft = edits[row.key];
    if (!draft || busy) return;
    const errors = draftErrors(draft);
    if (errors.label || errors.default_value || errors.position) return;
    const patch = patchFor(row, draft);
    if (Object.keys(patch).length === 0) return;
    setSavingKey(row.key);
    setRowErrors(({ [row.key]: _dropped, ...rest }) => rest);
    try {
      await verifyFreshFieldAuthority(identity);
      const saved = await patchMergeField(row.key, patch);
      writeRows((current) =>
        current.map((item) =>
          (item as { key?: unknown })?.key === row.key ? saved : item,
        ),
      );
      forget(row.key);
      toast.success(`Saved ${row.key}`);
    } catch (error: unknown) {
      setRowErrors((current) => ({
        ...current,
        [row.key]: apiErrorMessage(error, `${row.key} could not be saved.`),
      }));
    } finally {
      setSavingKey(null);
    }
  }

  async function removeRow(key: string) {
    setDeletingKey(key);
    try {
      await verifyFreshFieldAuthority(identity);
      await deleteMergeField(key);
    } catch (error: unknown) {
      throw new Error(apiErrorMessage(error, `${key} could not be removed.`));
    } finally {
      setDeletingKey(null);
    }
    writeRows((current) =>
      current.filter((item) => (item as { key?: unknown })?.key !== key),
    );
    forget(key);
    toast.success(`Removed ${key}`);
  }

  const newKey = newField.key.trim().toUpperCase();
  const newErrors = {
    key: !newField.key.trim()
      ? "A key is required."
      : !MERGE_FIELD_KEY_PATTERN.test(newField.key.trim())
        ? "Start with a letter; use up to 32 letters, numbers, or underscores."
        : rows.some((row) => row.key === newKey)
          ? "That key already exists."
          : null,
    ...draftErrors(newField),
  };
  const newFieldValid = !Object.values(newErrors).some(Boolean);

  async function addField() {
    if (!schemaAvailable || busy || !newFieldValid) return;
    setCreating(true);
    setCreateError(null);
    try {
      await verifyFreshFieldAuthority(identity);
      const created = await createMergeField({
        key: newKey,
        label: newField.label,
        type: newField.type,
        default_value: newField.default_value,
        required: newField.required,
        position: parsePosition(newField.position),
      });
      writeRows((current) => [...current, created]);
      setNewField(EMPTY_NEW_FIELD);
      toast.success(`Added ${created.key}`);
    } catch (error: unknown) {
      setCreateError(apiErrorMessage(error, `${newKey} could not be added.`));
    } finally {
      setCreating(false);
    }
  }

  const newIds = {
    key: `${baseId}-new-key`,
    label: `${baseId}-new-label`,
    type: `${baseId}-new-type`,
    default_value: `${baseId}-new-default`,
    position: `${baseId}-new-position`,
    required: `${baseId}-new-required`,
  };
  // "A key is required" is not news before anything was typed.
  const showNewError = (field: "key" | "label") =>
    newField[field] !== EMPTY_NEW_FIELD[field] ? newErrors[field] : null;

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent
          className="max-w-3xl"
          closeDisabled={busy}
          data-testid="merge-fields-schema-modal"
        >
          <DialogHeader>
            <DialogTitle>Audience fields</DialogTitle>
            <DialogDescription>
              Define reusable personalization fields without risking stored
              subscriber data.
            </DialogDescription>
          </DialogHeader>

          {schema.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading the audience-field schema…
            </p>
          ) : schema.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-destructive">
                {apiErrorMessage(schema.error, "The schema could not be loaded.")}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void schema.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : contractError ? (
            <p role="alert" className="text-sm text-destructive">
              {contractError}
            </p>
          ) : rows.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              No audience fields yet. Add the first one below.
            </p>
          ) : (
            <ul className="grid gap-3" aria-label="Audience fields">
              {rows.map((row) => {
                const draft = edits[row.key] ?? draftFromRow(row);
                const errors = draftErrors(draft);
                const dirty = dirtyKeys.includes(row.key);
                const locked = row.value_count > 0;
                const saving = savingKey === row.key;
                const disabled = busy;
                const ids = {
                  label: `${baseId}-${row.key}-label`,
                  type: `${baseId}-${row.key}-type`,
                  default_value: `${baseId}-${row.key}-default`,
                  position: `${baseId}-${row.key}-position`,
                  required: `${baseId}-${row.key}-required`,
                  usage: `${baseId}-${row.key}-usage`,
                };
                const update = (patch: Partial<FieldDraft>) =>
                  setEdits((current) => ({
                    ...current,
                    [row.key]: { ...(current[row.key] ?? draftFromRow(row)), ...patch },
                  }));
                return (
                  <li
                    key={row.key}
                    className="grid gap-3 rounded-md border p-3"
                    data-field-key={row.key}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <code className="break-all text-sm font-semibold">
                          {row.key}
                        </code>
                        <span className="text-xs text-muted-foreground">
                          {MERGE_FIELD_TYPE_COPY[row.type]}
                        </span>
                      </div>
                      <span id={ids.usage} className="text-xs tabular-nums text-muted-foreground">
                        {row.value_count.toLocaleString()}{" "}
                        {row.value_count === 1 ? "subscriber value" : "subscriber values"}
                      </span>
                    </div>
                    {locked ? (
                      <p className="text-xs text-muted-foreground">
                        Type and deletion are locked while this field contains
                        data. Labels, defaults, requirement, and order remain
                        editable.
                      </p>
                    ) : null}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label htmlFor={ids.label}>Label</Label>
                        <Input
                          id={ids.label}
                          value={draft.label}
                          maxLength={MERGE_FIELD_MAX_LABEL}
                          disabled={disabled}
                          aria-invalid={errors.label ? true : undefined}
                          onChange={(event) => update({ label: event.target.value })}
                        />
                        {errors.label ? (
                          <p className="text-xs text-destructive">{errors.label}</p>
                        ) : null}
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor={ids.type}>Type</Label>
                        <Select
                          id={ids.type}
                          value={draft.type}
                          disabled={disabled || locked}
                          aria-describedby={locked ? ids.usage : undefined}
                          onChange={(event) => {
                            const type = event.target.value as MergeFieldType;
                            update({
                              type,
                              ...(type === "boolean" &&
                              !["", "true", "false"].includes(draft.default_value)
                                ? { default_value: "" }
                                : {}),
                            });
                          }}
                        >
                          {MERGE_FIELD_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {MERGE_FIELD_TYPE_COPY[type]}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor={ids.default_value}>Default value</Label>
                        <DefaultValueControl
                          id={ids.default_value}
                          type={draft.type}
                          value={draft.default_value}
                          disabled={disabled}
                          invalid={Boolean(errors.default_value)}
                          onChange={(value) => update({ default_value: value })}
                        />
                        {errors.default_value ? (
                          <p className="text-xs text-destructive">
                            {errors.default_value}
                          </p>
                        ) : null}
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor={ids.position}>Display order</Label>
                        <Input
                          id={ids.position}
                          type="number"
                          step={1}
                          value={draft.position}
                          disabled={disabled}
                          aria-invalid={errors.position ? true : undefined}
                          onChange={(event) => update({ position: event.target.value })}
                        />
                        {errors.position ? (
                          <p className="text-xs text-destructive">{errors.position}</p>
                        ) : null}
                      </div>
                    </div>
                    <label htmlFor={ids.required} className="flex items-start gap-2 text-sm">
                      <Checkbox
                        id={ids.required}
                        checked={draft.required}
                        disabled={disabled}
                        onChange={(event) => update({ required: event.target.checked })}
                      />
                      <span>
                        <span className="font-medium">Reject empty values</span>
                        <span className="block text-xs text-muted-foreground">
                          Schema-aware edits cannot clear this field.
                        </span>
                      </span>
                    </label>
                    {rowErrors[row.key] ? (
                      <p role="alert" className="text-sm text-destructive">
                        {rowErrors[row.key]}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <ConfirmDialog
                        trigger={
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy || locked}
                            aria-describedby={locked ? ids.usage : undefined}
                          >
                            Remove
                          </Button>
                        }
                        title={`Remove ${row.key}?`}
                        description={
                          <>
                            This removes the field from the audience schema.
                            Moosewave will recheck for stored subscriber values
                            when you confirm. Templates that reference{" "}
                            <code>{row.key}</code> will render an empty value
                            until they are updated.
                          </>
                        }
                        confirmLabel="Remove field"
                        cancelLabel="Keep field"
                        onConfirm={() => removeRow(row.key)}
                      />
                      <span className="flex-1" />
                      {dirty ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => forget(row.key)}
                        >
                          Revert
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          busy ||
                          !dirty ||
                          Boolean(errors.label || errors.default_value || errors.position)
                        }
                        aria-busy={saving || undefined}
                        onClick={() => void saveRow(row)}
                      >
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <section aria-labelledby={`${baseId}-create`} className="grid gap-3 border-t pt-3">
            <h3 id={`${baseId}-create`} className="text-sm font-medium">
              Add a field
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={newIds.key}>Key</Label>
                <Input
                  id={newIds.key}
                  value={newField.key}
                  placeholder="FNAME"
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={!schemaAvailable || creating}
                  aria-invalid={showNewError("key") ? true : undefined}
                  onChange={(event) =>
                    setNewField((current) => ({ ...current, key: event.target.value }))
                  }
                />
                {showNewError("key") ? (
                  <p className="text-xs text-destructive">{newErrors.key}</p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={newIds.label}>Label</Label>
                <Input
                  id={newIds.label}
                  value={newField.label}
                  placeholder="First name"
                  maxLength={MERGE_FIELD_MAX_LABEL}
                  disabled={!schemaAvailable || creating}
                  onChange={(event) =>
                    setNewField((current) => ({ ...current, label: event.target.value }))
                  }
                />
                {showNewError("label") ? (
                  <p className="text-xs text-destructive">{newErrors.label}</p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={newIds.type}>Type</Label>
                <Select
                  id={newIds.type}
                  value={newField.type}
                  disabled={!schemaAvailable || creating}
                  onChange={(event) => {
                    const type = event.target.value as MergeFieldType;
                    setNewField((current) => ({
                      ...current,
                      type,
                      ...(type === "boolean" &&
                      !["", "true", "false"].includes(current.default_value)
                        ? { default_value: "" }
                        : {}),
                    }));
                  }}
                >
                  {MERGE_FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {MERGE_FIELD_TYPE_COPY[type]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={newIds.default_value}>Default value</Label>
                <DefaultValueControl
                  id={newIds.default_value}
                  type={newField.type}
                  value={newField.default_value}
                  disabled={!schemaAvailable || creating}
                  invalid={Boolean(newErrors.default_value)}
                  onChange={(value) =>
                    setNewField((current) => ({ ...current, default_value: value }))
                  }
                />
                {newErrors.default_value ? (
                  <p className="text-xs text-destructive">{newErrors.default_value}</p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={newIds.position}>Display order</Label>
                <Input
                  id={newIds.position}
                  type="number"
                  step={1}
                  value={newField.position}
                  disabled={!schemaAvailable || creating}
                  onChange={(event) =>
                    setNewField((current) => ({ ...current, position: event.target.value }))
                  }
                />
                {newErrors.position ? (
                  <p className="text-xs text-destructive">{newErrors.position}</p>
                ) : null}
              </div>
              <label htmlFor={newIds.required} className="flex items-start gap-2 self-end text-sm">
                <Checkbox
                  id={newIds.required}
                  checked={newField.required}
                  disabled={!schemaAvailable || creating}
                  onChange={(event) =>
                    setNewField((current) => ({ ...current, required: event.target.checked }))
                  }
                />
                <span className="font-medium">Reject empty values</span>
              </label>
            </div>
            {createError ? (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!schemaAvailable || busy || !newFieldValid}
                onClick={() => void addField()}
              >
                {creating ? "Adding…" : "Add field"}
              </Button>
              {newFieldDirty ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={creating}
                  onClick={() => {
                    setNewField(EMPTY_NEW_FIELD);
                    setCreateError(null);
                  }}
                >
                  Clear draft
                </Button>
              ) : null}
            </div>
          </section>

          <DialogFooter className="items-center">
            <span role="status" aria-live="polite" className="text-xs text-muted-foreground sm:mr-auto">
              {busy
                ? "Finishing schema changes…"
                : dirtyKeys.length > 0
                  ? `${dirtyKeys.length} unsaved ${dirtyKeys.length === 1 ? "field" : "fields"}`
                  : newFieldDirty
                    ? "1 unsaved draft"
                    : "All changes saved"}
            </span>
            <Button type="button" variant="outline" disabled={busy} onClick={requestClose}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard unsaved schema changes?"
        description="Saved fields stay intact. Local row edits and the new-field draft will be discarded."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setEdits({});
          setNewField(EMPTY_NEW_FIELD);
          onClose();
        }}
      />
    </>
  );
}

function DefaultValueControl({
  id,
  type,
  value,
  disabled,
  invalid,
  onChange,
}: {
  id: string;
  type: MergeFieldType;
  value: string;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  if (type === "boolean") {
    return (
      <Select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">No default</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </Select>
    );
  }
  return (
    <Input
      id={id}
      type={type === "number" ? "number" : type === "date" ? "date" : type === "phone" ? "tel" : "text"}
      step={type === "number" ? "any" : undefined}
      value={value}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      placeholder={type === "date" ? "YYYY-MM-DD" : "No default"}
      autoComplete="off"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
