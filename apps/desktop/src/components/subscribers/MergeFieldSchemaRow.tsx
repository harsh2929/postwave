import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  MergeFieldSchema,
  MergeFieldSchemaPatch,
  MergeFieldType,
} from "../../lib/api-client";
import { FormField } from "../FormField";

export const FIELD_TYPES: MergeFieldType[] = [
  "text",
  "number",
  "boolean",
  "date",
  "address",
  "phone",
];
export const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
export const MAX_LABEL_LENGTH = 200;
export const MIN_POSITION = -1_000_000;
export const MAX_POSITION = 1_000_000;
const MAX_VALUE_LENGTH = 4096;

export function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function validateMergeFieldPosition(value: number): string | null {
  if (!Number.isSafeInteger(value)) return "Enter a whole number.";
  if (value < MIN_POSITION || value > MAX_POSITION) {
    return `Use a value from ${MIN_POSITION.toLocaleString()} to ${MAX_POSITION.toLocaleString()}.`;
  }
  return null;
}

export const TYPE_COPY: Record<MergeFieldType, string> = {
  text: "Free-form text",
  number: "Numeric values",
  boolean: "True or false",
  date: "Calendar date",
  address: "Postal address",
  phone: "Phone number",
};

export function validateMergeFieldDefault(
  type: MergeFieldType,
  value: string,
): string | null {
  const normalized = value.trim();
  if (unicodeLength(normalized) > MAX_VALUE_LENGTH) {
    return `Use ${MAX_VALUE_LENGTH.toLocaleString()} characters or fewer.`;
  }
  if (!normalized) return null;
  if (type === "number" && !Number.isFinite(Number(normalized))) {
    return "Enter a valid number.";
  }
  if (type === "boolean" && normalized !== "true" && normalized !== "false") {
    return "Choose true or false.";
  }
  if (type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return "Use a complete date in YYYY-MM-DD format.";
  }
  if (type === "date") {
    const [year, month, day] = normalized.split("-").map(Number);
    if (!year || year < 1) return "Enter a real calendar date.";
    const parsed = new Date(Date.UTC(year!, month! - 1, day));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() + 1 !== month ||
      parsed.getUTCDate() !== day
    ) {
      return "Enter a real calendar date.";
    }
  }
  return null;
}

export function MergeFieldDefaultControl({
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
}): ReactElement {
  if (type === "boolean") {
    return (
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">No default</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }
  return (
    <input
      id={id}
      className="input"
      type={
        type === "number"
          ? "number"
          : type === "date"
            ? "date"
            : type === "phone"
              ? "tel"
              : "text"
      }
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

export function MergeFieldSchemaRow({
  row,
  disabled,
  saving,
  onPatch,
  onDelete,
  onDirtyChange,
}: {
  row: MergeFieldSchema;
  disabled: boolean;
  saving: boolean;
  onPatch: (patch: MergeFieldSchemaPatch) => Promise<boolean>;
  onDelete: () => void;
  onDirtyChange: (key: string, dirty: boolean) => void;
}): ReactElement {
  const [label, setLabel] = useState(row.label);
  const [type, setType] = useState<MergeFieldType>(row.type);
  const [defaultValue, setDefaultValue] = useState(row.default_value);
  const [required, setRequired] = useState(row.required);
  const [position, setPosition] = useState(row.position);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const usageId = `merge-schema-usage-${row.key}`;
  const requiredId = `mf-${row.key}-required`;
  const defaultError = validateMergeFieldDefault(type, defaultValue);
  const positionError = validateMergeFieldPosition(position);
  const labelError = !label.trim()
    ? "A label is required."
    : unicodeLength(label.trim()) > MAX_LABEL_LENGTH
      ? `Use ${MAX_LABEL_LENGTH} characters or fewer.`
      : null;
  const dirty =
    label !== row.label ||
    type !== row.type ||
    defaultValue !== row.default_value ||
    required !== row.required ||
    position !== row.position;
  const locked = row.value_count > 0;

  const restore = useCallback((): void => {
    setLabel(row.label);
    setType(row.type);
    setDefaultValue(row.default_value);
    setRequired(row.required);
    setPosition(row.position);
  }, [row]);

  useEffect(() => {
    restore();
  }, [restore]);

  useEffect(() => {
    onDirtyChange(row.key, dirty);
    return () => onDirtyChange(row.key, false);
  }, [dirty, onDirtyChange, row.key]);

  const save = async (): Promise<void> => {
    if (
      saving ||
      disabled ||
      labelError ||
      defaultError ||
      positionError ||
      !dirty
    )
      return;
    const saved = await onPatch({
      label: label.trim(),
      type,
      default_value: defaultValue.trim(),
      required,
      position,
    });
    if (saved) onDirtyChange(row.key, false);
  };

  return (
    <article
      className={`merge-schema-row${dirty ? " is-dirty" : ""}`}
      role="listitem"
    >
      <header className="merge-schema-row-header">
        <div className="merge-schema-row-identity">
          <code>{row.key}</code>
          <span>{TYPE_COPY[row.type]}</span>
        </div>
        <div
          className={`merge-schema-usage${locked ? " is-used" : ""}`}
          id={usageId}
        >
          <strong>{row.value_count.toLocaleString()}</strong>
          <span>
            {row.value_count === 1 ? "subscriber value" : "subscriber values"}
          </span>
        </div>
      </header>

      {locked ? (
        <p className="merge-schema-lock-note">
          Type and deletion are locked while this field contains data. Labels,
          defaults, requirement, and order remain editable.
        </p>
      ) : null}

      <div className="merge-schema-row-grid">
        <FormField
          label="Label"
          htmlFor={`mf-${row.key}-label`}
          error={labelError}
          required
        >
          <input
            ref={labelInputRef}
            id={`mf-${row.key}-label`}
            className="input"
            value={label}
            maxLength={MAX_LABEL_LENGTH}
            disabled={disabled || saving}
            onChange={(event) => setLabel(event.target.value)}
          />
        </FormField>
        <FormField
          label="Type"
          htmlFor={`mf-${row.key}-type`}
          help={locked ? "Locked because data exists" : TYPE_COPY[type]}
        >
          <select
            id={`mf-${row.key}-type`}
            className="input"
            value={type}
            disabled={disabled || saving || locked}
            aria-describedby={locked ? usageId : undefined}
            onChange={(event) => {
              const next = event.target.value as MergeFieldType;
              setType(next);
              if (
                next === "boolean" &&
                !["", "true", "false"].includes(defaultValue)
              ) {
                setDefaultValue("");
              }
            }}
          >
            {FIELD_TYPES.map((fieldType) => (
              <option key={fieldType} value={fieldType}>
                {TYPE_COPY[fieldType]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Default value"
          htmlFor={`mf-${row.key}-default`}
          help="Audience-field editor fallback"
          error={defaultError}
        >
          <MergeFieldDefaultControl
            id={`mf-${row.key}-default`}
            type={type}
            value={defaultValue}
            disabled={disabled || saving}
            invalid={Boolean(defaultError)}
            onChange={setDefaultValue}
          />
        </FormField>
        <FormField
          label="Display order"
          htmlFor={`mf-${row.key}-position`}
          error={positionError}
        >
          <input
            id={`mf-${row.key}-position`}
            className="input"
            type="number"
            step="1"
            min={MIN_POSITION}
            max={MAX_POSITION}
            value={position}
            disabled={disabled || saving}
            aria-invalid={Boolean(positionError) || undefined}
            onChange={(event) => setPosition(Number(event.target.value) || 0)}
          />
        </FormField>
        <label
          className="merge-schema-required-toggle is-compact"
          htmlFor={requiredId}
        >
          <span className="sr-only">Required field</span>
          <input
            id={requiredId}
            type="checkbox"
            checked={required}
            disabled={disabled || saving}
            onChange={(event) => setRequired(event.target.checked)}
          />
          <span>
            <strong>Reject empty values</strong>
            <small>Schema-aware edits cannot clear this field.</small>
          </span>
        </label>
      </div>

      <footer className="merge-schema-row-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={disabled || saving || locked}
          aria-describedby={locked ? usageId : undefined}
          onClick={onDelete}
        >
          Remove
        </button>
        <span className="spacer" />
        {dirty ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled || saving}
            onClick={() => {
              restore();
              labelInputRef.current?.focus();
            }}
          >
            Revert
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={
            disabled ||
            saving ||
            !dirty ||
            Boolean(labelError || defaultError || positionError)
          }
          aria-busy={saving || undefined}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </footer>
    </article>
  );
}
