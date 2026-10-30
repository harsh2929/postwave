/**
 * FormFieldsEditor — manages the list of custom fields a form
 * collects beyond the always-on email input. Persists to the form's
 * `structure.fields` jsonb column on save; the public form renderer
 * (apps/api/internal/forms/embed.go) consumes the same shape.
 *
 * Field shape mirrors `forms.FormStepField`:
 *
 *   { key, label, type, required, options? }
 *
 * Types supported: text, email, tel, url, number, select, checkbox.
 * For `select` we surface a comma-separated `options` input.
 *
 * The editor does NOT push to the server itself — it bubbles a draft
 * `fields` array up to its parent which folds it into the existing
 * structure jsonb on save. That keeps this component pure and matches
 * the rest of the slideover's "draft → save settings" rhythm.
 */

import { type ReactElement, useEffect, useId, useState } from "react";

import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";

export interface FormField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
}

interface Props {
  /** Initial fields from the form's `structure.fields`. */
  initial: FormField[];
  /** Fired on every local edit so the parent can mark dirty / enable save. */
  onChange: (fields: FormField[]) => void;
  /** Disables every control. */
  disabled?: boolean;
}

const FIELD_TYPES: Array<{ value: string; label: string }> = [
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
  { value: "tel", label: "Phone" },
  { value: "url", label: "URL" },
  { value: "number", label: "Number" },
  { value: "select", label: "Dropdown" },
  { value: "checkbox", label: "Checkbox" },
  { value: "textarea", label: "Long text" },
];

function slugifyKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

export function formFieldKeyError(
  fields: readonly FormField[],
  key: string,
  ownIndex: number,
): string | null {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    return "Key must be lowercase letters/numbers/underscore.";
  }
  if (key === "email") return "`email` is reserved.";
  const duplicateIndex = fields.findIndex(
    (field, index) => index !== ownIndex && field.key === key,
  );
  return duplicateIndex === -1
    ? null
    : `Duplicate of field ${duplicateIndex + 1}.`;
}

export function firstFormFieldError(
  fields: readonly FormField[],
): { index: number; message: string } | null {
  for (let index = 0; index < fields.length; index += 1) {
    const message = formFieldKeyError(fields, fields[index]?.key ?? "", index);
    if (message) return { index, message };
  }
  return null;
}

interface FormFieldCardProps {
  field: FormField;
  index: number;
  fieldCount: number;
  keyError: string | null;
  disabled?: boolean;
  onUpdate: (patch: Partial<FormField>) => void;
  onMove: (delta: number) => void;
  onRequestRemove: () => void;
}

function FormFieldCard({
  field,
  index,
  fieldCount,
  keyError,
  disabled,
  onUpdate,
  onMove,
  onRequestRemove,
}: FormFieldCardProps): ReactElement {
  const controlId = useId();
  const labelInputId = `${controlId}-label`;
  const keyInputId = `${controlId}-key`;
  const keyErrorId = `${controlId}-key-error`;
  const typeInputId = `${controlId}-type`;
  const optionsInputId = `${controlId}-options`;
  const moveUpReasonId = useId();
  const moveDownReasonId = useId();
  const moveUpUnavailable = Boolean(disabled || index === 0);
  const moveDownUnavailable = Boolean(disabled || index === fieldCount - 1);
  const fieldName = field.label.trim() || `field ${index + 1}`;
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 4,
        padding: 8,
        background: "var(--pw-bg-elev-2)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
        }}
      >
        <div>
          <label
            htmlFor={labelInputId}
            className="muted"
            style={{ display: "block", fontSize: 10, marginBottom: 2 }}
          >
            Label
            <span className="visually-hidden"> for field {index + 1}</span>
          </label>
          <input
            id={labelInputId}
            type="text"
            className="input"
            style={{ fontSize: 12, padding: "4px 6px" }}
            value={field.label}
            placeholder="First name"
            onChange={(event) => onUpdate({ label: event.target.value })}
            disabled={disabled}
          />
        </div>
        <div>
          <label
            htmlFor={keyInputId}
            className="muted"
            style={{ display: "block", fontSize: 10, marginBottom: 2 }}
          >
            Key
            <span className="visually-hidden"> for field {index + 1}</span>
          </label>
          <input
            id={keyInputId}
            type="text"
            className="input mono"
            style={{ fontSize: 12, padding: "4px 6px" }}
            value={field.key}
            placeholder="first_name"
            onChange={(event) => onUpdate({ key: event.target.value })}
            disabled={disabled}
            aria-invalid={keyError ? true : undefined}
            aria-describedby={keyError ? keyErrorId : undefined}
            aria-errormessage={keyError ? keyErrorId : undefined}
          />
          {keyError ? (
            <div
              id={keyErrorId}
              style={{
                fontSize: 10,
                color: "var(--pw-danger)",
                marginTop: 2,
              }}
            >
              {keyError}
            </div>
          ) : null}
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          marginTop: 6,
        }}
      >
        <div>
          <label
            htmlFor={typeInputId}
            className="muted"
            style={{ display: "block", fontSize: 10, marginBottom: 2 }}
          >
            Type
            <span className="visually-hidden"> for field {index + 1}</span>
          </label>
          <select
            id={typeInputId}
            className="input"
            style={{ fontSize: 12, padding: "4px 6px" }}
            value={field.type}
            onChange={(event) => onUpdate({ type: event.target.value })}
            disabled={disabled}
          >
            {FIELD_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4 }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              flex: 1,
            }}
          >
            <input
              type="checkbox"
              checked={field.required ?? false}
              onChange={(event) => onUpdate({ required: event.target.checked })}
              disabled={disabled}
            />
            Required
          </label>
        </div>
      </div>
      {field.type === "select" ? (
        <div style={{ marginTop: 6 }}>
          <label
            htmlFor={optionsInputId}
            className="muted"
            style={{ display: "block", fontSize: 10, marginBottom: 2 }}
          >
            Options (comma-separated)
            <span className="visually-hidden"> for field {index + 1}</span>
          </label>
          <input
            id={optionsInputId}
            type="text"
            className="input"
            style={{ fontSize: 12, padding: "4px 6px" }}
            value={(field.options ?? []).join(", ")}
            placeholder="Free, Pro, Enterprise"
            onChange={(event) =>
              onUpdate({
                options: event.target.value
                  .split(",")
                  .map((option) => option.trim())
                  .filter(Boolean),
              })
            }
            disabled={disabled}
          />
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginTop: 8,
          justifyContent: "flex-end",
        }}
      >
        {moveUpUnavailable ? (
          <span id={moveUpReasonId} className="visually-hidden">
            {disabled
              ? "Field order is unavailable while form settings are read-only or saving."
              : `${fieldName} is already the first field.`}
          </span>
        ) : null}
        {moveDownUnavailable ? (
          <span id={moveDownReasonId} className="visually-hidden">
            {disabled
              ? "Field order is unavailable while form settings are read-only or saving."
              : `${fieldName} is already the last field.`}
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (moveUpUnavailable) return;
            onMove(-1);
          }}
          aria-label={`Move ${fieldName} up`}
          aria-disabled={moveUpUnavailable || undefined}
          aria-describedby={moveUpUnavailable ? moveUpReasonId : undefined}
        >
          <span aria-hidden="true">↑</span>
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (moveDownUnavailable) return;
            onMove(1);
          }}
          aria-label={`Move ${fieldName} down`}
          aria-disabled={moveDownUnavailable || undefined}
          aria-describedby={moveDownUnavailable ? moveDownReasonId : undefined}
        >
          <span aria-hidden="true">↓</span>
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={onRequestRemove}
          disabled={disabled}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

export function FormFieldsEditor({
  initial,
  onChange,
  disabled,
}: Props): ReactElement {
  const [fields, setFields] = useState<FormField[]>(initial);
  // Index of the field a Remove click is asking to confirm. The
  // in-app ConfirmModal replaces window.confirm, which silently
  // no-ops in the Tauri webview (fields could never be removed).
  const [removeIdx, setRemoveIdx] = useState<number | null>(null);

  // Sync local state when the parent reloads the form (e.g. after save).
  useEffect(() => {
    setFields(initial);
    setRemoveIdx(null);
  }, [initial]);

  const push = (next: FormField[]): void => {
    setFields(next);
    onChange(next);
  };

  const addField = (): void => {
    const label = `Field ${fields.length + 1}`;
    push([
      ...fields,
      {
        key: slugifyKey(label) || `field_${fields.length + 1}`,
        label,
        type: "text",
        required: false,
      },
    ]);
  };

  const removeField = (i: number): void => {
    setRemoveIdx(null);
    push(fields.filter((_, j) => j !== i));
  };

  const update = (i: number, patch: Partial<FormField>): void => {
    push(
      fields.map((f, j) => {
        if (j !== i) return f;
        const next = { ...f, ...patch };
        // Auto-derive key from label if the operator hasn't customised
        // the key — keeps payloads readable without forcing extra typing.
        if (patch.label !== undefined && f.key === slugifyKey(f.label)) {
          next.key = slugifyKey(patch.label) || f.key;
        }
        return next;
      }),
    );
  };

  const move = (i: number, delta: number): void => {
    const j = i + delta;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j]!, next[i]!];
    push(next);
  };

  return (
    <div>
      <div className="label">Custom fields</div>
      <div
        className="muted"
        style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}
      >
        Email is collected by default. Add custom fields below to capture name,
        company, plan, etc. The field <code className="mono">key</code> appears
        in the submission JSON; the <code className="mono">label</code> is what
        the visitor sees.
      </div>

      {fields.length === 0 ? (
        <div
          className="muted"
          style={{
            fontSize: 12,
            padding: "12px",
            border: "1px dashed var(--pw-border)",
            borderRadius: 4,
            textAlign: "center",
          }}
        >
          No custom fields yet. The form will only collect the email.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {fields.map((field, index) => (
            <FormFieldCard
              key={index}
              field={field}
              index={index}
              fieldCount={fields.length}
              keyError={formFieldKeyError(fields, field.key, index)}
              disabled={disabled}
              onUpdate={(patch) => update(index, patch)}
              onMove={(delta) => move(index, delta)}
              onRequestRemove={() => setRemoveIdx(index)}
            />
          ))}
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (fields.length >= 12) {
              toast.error(
                "12-field cap — consider splitting into multiple forms.",
              );
              return;
            }
            addField();
          }}
          disabled={disabled}
        >
          + Add field
        </button>
      </div>

      <ConfirmModal
        open={removeIdx !== null}
        title="Remove field?"
        description={`Remove "${
          (removeIdx !== null ? fields[removeIdx]?.label : undefined) ??
          "this field"
        }"? Existing submissions keep their data.`}
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (removeIdx !== null) removeField(removeIdx);
        }}
        onClose={() => setRemoveIdx(null)}
      />
    </div>
  );
}
