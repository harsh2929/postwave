import {
  type Dispatch,
  type ReactElement,
  type RefObject,
  type SetStateAction,
} from "react";

import type {
  MergeFieldSchema,
  MergeFieldSchemaPatch,
  MergeFieldType,
} from "../../lib/api-client";
import { FormField } from "../FormField";
import {
  FIELD_TYPES,
  MAX_LABEL_LENGTH,
  MAX_POSITION,
  MIN_POSITION,
  MergeFieldDefaultControl,
  MergeFieldSchemaRow,
  TYPE_COPY,
} from "./MergeFieldSchemaRow";

interface SchemaStatusAndListProps {
  rows: MergeFieldSchema[] | null;
  loading: boolean;
  loadError: string | null;
  externalChangePending: boolean;
  schemaAvailable: boolean;
  hasUnsavedChanges: boolean;
  mutationBusy: boolean;
  usedFieldCount: number;
  savingKeys: Set<string>;
  onLoad: () => void;
  onUpdateRow: (key: string, patch: MergeFieldSchemaPatch) => Promise<boolean>;
  onRequestDelete: (key: string) => void;
  onDirtyChange: (key: string, dirty: boolean) => void;
}

export function MergeFieldsSchemaStatusAndList({
  rows,
  loading,
  loadError,
  externalChangePending,
  schemaAvailable,
  hasUnsavedChanges,
  mutationBusy,
  usedFieldCount,
  savingKeys,
  onLoad,
  onUpdateRow,
  onRequestDelete,
  onDirtyChange,
}: SchemaStatusAndListProps): ReactElement {
  return (
    <>
      <section className="merge-schema-overview" aria-label="Schema summary">
        <div>
          <span>Fields</span>
          <strong>{rows?.length ?? "—"}</strong>
        </div>
        <div>
          <span>Containing data</span>
          <strong>{rows ? usedFieldCount : "—"}</strong>
        </div>
        <p>
          Use keys such as <code>FNAME</code> in templates. Keys never change;
          fields containing data keep their type and cannot be deleted.
        </p>
      </section>

      {loadError ? (
        <div className="notice merge-schema-load-error" role="alert">
          <div>
            <strong>Schema unavailable</strong>
            <span>{loadError}</span>
            {rows ? <small>Last loaded fields remain read-only.</small> : null}
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading}
            onClick={onLoad}
          >
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}

      {externalChangePending ? (
        <div className="notice merge-schema-load-error" role="status">
          <div>
            <strong>A field changed while this editor was open</strong>
            <span>
              Refresh after saving or reverting local drafts to reconcile the
              latest server state.
            </span>
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={hasUnsavedChanges || mutationBusy}
            onClick={onLoad}
          >
            Refresh fields
          </button>
        </div>
      ) : null}

      {loading && rows === null ? (
        <div className="merge-schema-loading" role="status" aria-live="polite">
          <span className="skel" />
          <span className="skel" />
          <span className="skel" />
          <span className="sr-only">Loading audience fields…</span>
        </div>
      ) : rows ? (
        <section
          className="merge-schema-existing"
          aria-labelledby="merge-schema-existing-title"
        >
          <div className="merge-schema-section-heading">
            <div>
              <span className="merge-schema-eyebrow">Current schema</span>
              <h3 id="merge-schema-existing-title">Personalization fields</h3>
            </div>
            {loading ? (
              <span className="merge-schema-refreshing" role="status">
                Refreshing…
              </span>
            ) : null}
          </div>
          {rows.length > 0 ? (
            <div className="merge-schema-list" role="list">
              {rows.map((row) => (
                <MergeFieldSchemaRow
                  key={row.key}
                  row={row}
                  disabled={!schemaAvailable}
                  saving={savingKeys.has(row.key)}
                  onPatch={(patch) => onUpdateRow(row.key, patch)}
                  onDelete={() => onRequestDelete(row.key)}
                  onDirtyChange={onDirtyChange}
                />
              ))}
            </div>
          ) : (
            <div className="merge-schema-empty">
              <strong>No audience fields yet</strong>
              <span>
                Create the first field below. Nothing is added until you
                confirm.
              </span>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}

interface SchemaCreateSectionProps {
  schemaAvailable: boolean;
  adding: boolean;
  draftKey: string;
  draftLabel: string;
  draftType: MergeFieldType;
  draftDefault: string;
  draftRequired: boolean;
  draftPosition: number;
  draftDirty: boolean;
  draftKeyError: string | null;
  draftLabelError: string | null;
  draftDefaultError: string | null;
  draftPositionError: string | null;
  draftKeyRef: RefObject<HTMLInputElement | null>;
  createHeadingRef: RefObject<HTMLHeadingElement | null>;
  setDraftKey: Dispatch<SetStateAction<string>>;
  setDraftLabel: Dispatch<SetStateAction<string>>;
  setDraftType: Dispatch<SetStateAction<MergeFieldType>>;
  setDraftDefault: Dispatch<SetStateAction<string>>;
  setDraftRequired: Dispatch<SetStateAction<boolean>>;
  setDraftPosition: Dispatch<SetStateAction<number>>;
  onResetDraft: () => void;
  onSubmit: () => void;
}

export function MergeFieldsSchemaCreateSection({
  schemaAvailable,
  adding,
  draftKey,
  draftLabel,
  draftType,
  draftDefault,
  draftRequired,
  draftPosition,
  draftDirty,
  draftKeyError,
  draftLabelError,
  draftDefaultError,
  draftPositionError,
  draftKeyRef,
  createHeadingRef,
  setDraftKey,
  setDraftLabel,
  setDraftType,
  setDraftDefault,
  setDraftRequired,
  setDraftPosition,
  onResetDraft,
  onSubmit,
}: SchemaCreateSectionProps): ReactElement {
  return (
    <section
      className={`merge-schema-create${schemaAvailable ? "" : " is-disabled"}`}
      aria-labelledby="merge-schema-create-title"
      aria-disabled={!schemaAvailable || undefined}
    >
      <div className="merge-schema-section-heading">
        <div>
          <span className="merge-schema-eyebrow">New field</span>
          <h3
            id="merge-schema-create-title"
            ref={createHeadingRef}
            tabIndex={-1}
          >
            Add a personalization field
          </h3>
        </div>
        <span className="merge-schema-draft-state">
          {draftDirty ? "Unsaved draft" : "Ready when you are"}
        </span>
      </div>
      <div className="merge-schema-create-grid">
        <FormField
          label="Merge key"
          htmlFor="mf-new-key"
          help="Permanent template token"
          error={draftKey ? draftKeyError : null}
          required
        >
          <input
            ref={draftKeyRef}
            id="mf-new-key"
            className="input merge-schema-key-input"
            placeholder="FNAME"
            value={draftKey}
            maxLength={32}
            disabled={!schemaAvailable || adding}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            onBlur={() => setDraftKey((value) => value.trim().toUpperCase())}
            onChange={(event) => setDraftKey(event.target.value)}
          />
        </FormField>
        <FormField
          label="Label"
          htmlFor="mf-new-label"
          help="Shown to teammates"
          error={draftLabel ? draftLabelError : null}
          required
        >
          <input
            id="mf-new-label"
            className="input"
            placeholder="First name"
            value={draftLabel}
            maxLength={MAX_LABEL_LENGTH}
            disabled={!schemaAvailable || adding}
            onChange={(event) => setDraftLabel(event.target.value)}
          />
        </FormField>
        <FormField
          label="Type"
          htmlFor="mf-new-type"
          help={TYPE_COPY[draftType]}
        >
          <select
            id="mf-new-type"
            className="input"
            value={draftType}
            disabled={!schemaAvailable || adding}
            onChange={(event) => {
              const next = event.target.value as MergeFieldType;
              setDraftType(next);
              if (
                next === "boolean" &&
                !["", "true", "false"].includes(draftDefault)
              ) {
                setDraftDefault("");
              }
            }}
          >
            {FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_COPY[type]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Default value"
          htmlFor="mf-new-default"
          help="Fallback in audience-field editors; templates use stored profile data"
          error={draftDefaultError}
        >
          <MergeFieldDefaultControl
            id="mf-new-default"
            type={draftType}
            value={draftDefault}
            disabled={!schemaAvailable || adding}
            invalid={Boolean(draftDefaultError)}
            onChange={setDraftDefault}
          />
        </FormField>
        <FormField
          label="Display order"
          htmlFor="mf-new-position"
          help="Lower numbers appear first"
          error={draftPositionError}
        >
          <input
            id="mf-new-position"
            className="input"
            type="number"
            step="1"
            min={MIN_POSITION}
            max={MAX_POSITION}
            value={draftPosition}
            disabled={!schemaAvailable || adding}
            aria-invalid={Boolean(draftPositionError) || undefined}
            onChange={(event) =>
              setDraftPosition(Number(event.target.value) || 0)
            }
          />
        </FormField>
        <label
          className="merge-schema-required-toggle"
          htmlFor="mf-new-required"
        >
          <span className="sr-only">Required field</span>
          <input
            id="mf-new-required"
            type="checkbox"
            checked={draftRequired}
            disabled={!schemaAvailable || adding}
            onChange={(event) => setDraftRequired(event.target.checked)}
          />
          <span>
            <strong>Reject empty values</strong>
            <small>Schema-aware edits cannot clear this field.</small>
          </span>
        </label>
      </div>
      <div className="merge-schema-create-actions">
        {draftDirty ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={adding}
            onClick={() => {
              onResetDraft();
              draftKeyRef.current?.focus();
            }}
          >
            Clear draft
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            adding ||
            !schemaAvailable ||
            Boolean(
              draftKeyError ||
              draftLabelError ||
              draftDefaultError ||
              draftPositionError,
            )
          }
          aria-busy={adding || undefined}
          onClick={onSubmit}
        >
          {adding ? "Adding field…" : "Add field"}
        </button>
      </div>
    </section>
  );
}
