import type { KeyboardEvent, ReactElement } from "react";

import type {
  SubscriberImportDryRunResults,
  SubscriberImportPreview,
  SubscriberImportRemapOptions,
  SubscriberImportStrategy,
} from "../../lib/api-client";
import type { ImportPolicy } from "../../lib/file-transfer-types";
import { fmtDateTime, fmtRelative } from "../../lib/format-date";
import {
  IMPORT_CONSENT_CONFIRMATION,
  IMPORT_CONSENT_CONTRACT_VERSION,
  IMPORT_CONSENT_SCOPE,
  IMPORT_CONSENT_SOURCES,
  type ImportConsentDraft,
  type ImportConsentErrors,
} from "./consent-evidence";
import {
  type ImportMappingColumn,
  MAX_IMPORT_TAGS,
  MAX_TAG_LENGTH,
  applyColumnKind,
  importPreflightIsFresh,
  mappingHasEmail,
  mappingPatchError,
  mappingTargetConflicts,
  propertyCandidatesFromMapping,
} from "./import-options";
import { DryRunResults, ImportMetricTile, ImportProgress } from "./ImportRunEvidence";

export type ImportStepId = "upload" | "mapping" | "consent" | "options" | "review";

export const IMPORT_STEPS: ReadonlyArray<{
  id: ImportStepId;
  label: string;
  summary: string;
}> = [
  { id: "upload", label: "Source", summary: "Choose a CSV" },
  { id: "mapping", label: "Fields", summary: "Bind every column" },
  { id: "consent", label: "Consent", summary: "Prove or protect" },
  { id: "options", label: "Handling", summary: "Tags and collisions" },
  { id: "review", label: "Verify", summary: "Preflight and queue" },
];

function currentLocalDateTimeMax(now = new Date()): string {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function ImportStepper({ stepIndex }: { stepIndex: number }): ReactElement {
  return (
    <nav className="subscriber-import-stepper" aria-label="Import progress">
      <ol aria-label="Subscriber import steps">
        {IMPORT_STEPS.map((item, index) => {
          const active = index === stepIndex;
          const done = index < stepIndex;
          return (
            <li
              key={item.id}
              className={active ? "is-active" : done ? "is-complete" : undefined}
              aria-current={active ? "step" : undefined}
            >
              <span className="subscriber-import-step-number" aria-hidden="true">
                {done ? "✓" : index + 1}
              </span>
              <span className="subscriber-import-step-copy">
                <strong>{item.label}</strong>
                <small>{item.summary}</small>
              </span>
            </li>
          );
        })}
      </ol>
      <div
        className={`subscriber-import-step-progress is-step-${stepIndex}`}
        aria-hidden="true"
      />
    </nav>
  );
}

export function UploadStep({
  file,
  onPick,
  policy,
  formatBytes,
}: {
  file: File | null;
  onPick: () => void;
  policy: ImportPolicy;
  formatBytes: (value: number) => string;
}): ReactElement {
  return (
    <section className="subscriber-import-step" aria-labelledby="import-source-title">
      <header className="subscriber-import-step-heading">
        <span className="subscriber-import-eyebrow">Private source review</span>
        <h3 id="import-source-title">Start with the exact file you intend to run</h3>
        <p>
          Moosewave exhaustively classifies the CSV after you map it. Uploading a
          file never proves marketing consent and never writes subscribers.
        </p>
      </header>
      <button type="button" className="subscriber-import-dropzone" onClick={onPick}>
        <span className="subscriber-import-dropzone-icon" aria-hidden="true">↑</span>
        <span className="subscriber-import-dropzone-copy">
          <strong>{file ? file.name : "Choose a subscriber CSV"}</strong>
          <span>
            {file
              ? `${formatBytes(file.size)} · ready for a server-bound preview`
              : `CSV only · up to ${formatBytes(policy.maxBytes)} · one Email column required`}
          </span>
        </span>
        <span className="btn">{file ? "Choose another" : "Browse"}</span>
      </button>
      <div className="subscriber-import-safety-grid" role="list" aria-label="Upload safeguards">
        <div role="listitem"><strong>No subscriber writes</strong><span>Preview and preflight remain read-only.</span></div>
        <div role="listitem"><strong>Source-bound review</strong><span>A keyed fingerprint binds approval to these bytes.</span></div>
        <div role="listitem"><strong>24-hour review window</strong><span>Uploaded review artifacts are time-bounded.</span></div>
      </div>
      <p className="subscriber-import-retention-note">
        Treat this file as confidential customer data. Do not include secrets in
        column names, tags, consent reasons, or evidence references.
      </p>
    </section>
  );
}

export function MappingStep({
  preview,
  columns,
  detected,
  remapOptions,
  autoCreate,
  onAutoCreate,
  onColumnsChange,
}: {
  preview: SubscriberImportPreview;
  columns: ImportMappingColumn[];
  detected: ImportMappingColumn[];
  remapOptions: SubscriberImportRemapOptions | null;
  autoCreate: boolean;
  onAutoCreate: (value: boolean) => void;
  onColumnsChange: (columns: ImportMappingColumn[]) => void;
}): ReactElement {
  const mergeFields =
    remapOptions?.merge_fields.length
      ? remapOptions.merge_fields
      : DEFAULT_MERGE_FIELDS;
  const customFields = remapOptions?.custom_fields ?? [];
  const candidates = propertyCandidatesFromMapping({ columns });
  const conflicts = mappingTargetConflicts(columns);
  const conflictByColumn = new Map(
    conflicts.flatMap((conflict) =>
      conflict.sources.map((source) => [source.index, conflict] as const),
    ),
  );
  const geometryError = mappingPatchError(preview.mapping, columns);
  const dirty =
    columns.length !== detected.length ||
    columns.some((column, index) => {
      const original = detected[index];
      return (
        !original ||
        original.index !== column.index ||
        original.name !== column.name ||
        original.kind !== column.kind ||
        original.custom_key !== column.custom_key
      );
    });

  return (
    <section className="subscriber-import-step" aria-labelledby="import-mapping-title">
      <header className="subscriber-import-step-heading subscriber-import-heading-row">
        <div>
          <span className="subscriber-import-eyebrow">Canonical geometry</span>
          <h3 id="import-mapping-title">Decide where every source column lands</h3>
          <p>
            {columns.length.toLocaleString()} headers · {(preview.rows_total ?? 0).toLocaleString()} rows.
            Status and consent timestamps cannot be imported as eligibility claims.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => onColumnsChange(detected.map((column) => ({ ...column })))}
          disabled={!dirty}
        >
          Reset detection
        </button>
      </header>

      {geometryError ? (
        <div className="subscriber-import-alert is-danger" role="alert">
          <strong>Mapping needs attention</strong>
          <span>{geometryError}</span>
          {conflicts.length ? (
            <ul>
              {conflicts.map((conflict) => (
                <li key={conflict.target}>
                  {conflict.label}: {conflict.sources.map((source) => `“${source.name}”`).join(", ")}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="subscriber-import-alert is-success" role="status">
          <strong>Mapping is deterministic</strong>
          <span>Every header has one index, one destination, and exactly one Email source.</span>
        </div>
      )}

      <div className="subscriber-import-alert" role="note">
        <strong>Raw row values stay out of this editor</strong>
        <span>
          Only bounded header names and field destinations are shown.
          {preview.sample_values_truncated
            ? " Oversized preview cells were clipped or omitted by the server before this review loaded."
            : " The bounded server sample required no value clipping."}
        </span>
      </div>

      <div className="subscriber-import-mapping-list" role="list" aria-label="CSV field mappings">
        {columns.map((column, index) => {
          const original = detected[index];
          const changed =
            !original ||
            original.kind !== column.kind ||
            original.custom_key !== column.custom_key;
          const conflict = conflictByColumn.get(column.index);
          const targetError =
            column.kind === "custom" && !/^[a-z][a-z0-9_]{0,63}$/.test(column.custom_key ?? "")
              ? "Use lowercase letters, numbers, and underscores; start with a letter."
              : conflict
                ? `${conflict.label} is also assigned to ${conflict.sources
                    .filter((source) => source.index !== column.index)
                    .map((source) => `“${source.name}”`)
                    .join(", ")}.`
                : null;
          const errorId = targetError ? `import-map-error-${column.index}` : undefined;
          return (
            <div key={`${column.index}:${column.name}`} className={changed ? "is-changed" : undefined} role="listitem">
              <div className="subscriber-import-source-field">
                <span className="subscriber-import-column-index">{String(column.index + 1).padStart(2, "0")}</span>
                <span><strong title={column.name}>{column.name}</strong><small>{changed ? "Operator override" : "Server detected"}</small></span>
              </div>
              <span className="subscriber-import-map-arrow" aria-hidden="true">→</span>
              <div className="subscriber-import-target-field">
                <label>
                  <span className="visually-hidden">Destination for {column.name}</span>
                  <select
                    className="input"
                    value={column.kind}
                    aria-label={`Map column ${column.name}`}
                    aria-invalid={Boolean(targetError) || undefined}
                    aria-describedby={errorId}
                    onChange={(event) =>
                      onColumnsChange(
                        applyColumnKind(
                          columns,
                          column.index,
                          event.target.value as ImportMappingColumn["kind"],
                        ),
                      )
                    }
                  >
                    {mergeFields.map((field) => (
                      <option key={field.kind} value={field.kind}>{field.label}</option>
                    ))}
                  </select>
                </label>
                {column.kind === "custom" ? (
                  <label>
                    <span className="visually-hidden">Custom field key for {column.name}</span>
                    <input
                      className="input"
                      type="text"
                      list="subscriber-import-custom-fields"
                      value={column.custom_key ?? ""}
                      maxLength={64}
                      spellCheck={false}
                      autoCapitalize="none"
                      aria-label={`Custom field for column ${column.name}`}
                      aria-invalid={Boolean(targetError) || undefined}
                      aria-describedby={errorId}
                      onChange={(event) =>
                        onColumnsChange(
                          applyColumnKind(columns, column.index, "custom", event.target.value),
                        )
                      }
                    />
                  </label>
                ) : (
                  <span className="subscriber-import-target-description">
                    {column.kind === "ignore" ? "Excluded from every write" : "Canonical subscriber field"}
                  </span>
                )}
                {targetError ? <span id={errorId} className="field-error">{targetError}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
      <datalist id="subscriber-import-custom-fields">
        {customFields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
      </datalist>

      <label className="subscriber-import-check-card" htmlFor="subscriber-import-auto-create" aria-label="Register missing custom fields">
        <input
          id="subscriber-import-auto-create"
          type="checkbox"
          checked={autoCreate}
          onChange={(event) => onAutoCreate(event.target.checked)}
          disabled={candidates.length === 0}
        />
        <span>
          <strong>Register missing custom fields</strong>
          <small>
            {candidates.length
              ? `${candidates.join(", ")} will be created as governed string fields if absent. Any schema failure stops execution.`
              : "No mapped custom keys require registration."}
          </small>
        </span>
      </label>
      {!mappingHasEmail(columns) ? <p className="field-error">Choose exactly one Email destination to continue.</p> : null}
    </section>
  );
}

const DEFAULT_MERGE_FIELDS: SubscriberImportRemapOptions["merge_fields"] = [
  { kind: "email", label: "Email · required" },
  { kind: "name", label: "Name" },
  { kind: "tags", label: "Tags" },
  { kind: "custom", label: "Custom field" },
  { kind: "ignore", label: "Skip this column" },
];

export function ConsentStep({
  draft,
  errors,
  revealErrors,
  onChange,
}: {
  draft: ImportConsentDraft;
  errors: ImportConsentErrors;
  revealErrors: boolean;
  onChange: (draft: ImportConsentDraft) => void;
}): ReactElement {
  const update = <K extends keyof ImportConsentDraft>(key: K, value: ImportConsentDraft[K]): void => {
    onChange({ ...draft, [key]: value });
  };
  const error = (field: keyof ImportConsentErrors): string | undefined =>
    revealErrors ? errors[field] : undefined;
  return (
    <section className="subscriber-import-step" aria-labelledby="import-consent-title">
      <header className="subscriber-import-step-heading">
        <span className="subscriber-import-eyebrow">Eligibility boundary</span>
        <h3 id="import-consent-title">Separate an uploaded list from permission to send</h3>
        <p>
          Choose the safe default unless you hold complete first-party evidence for every new row.
          Existing subscriber consent and suppression state is always preserved.
        </p>
      </header>

      <fieldset className="subscriber-import-choice-grid">
        <legend className="visually-hidden">Consent evidence mode</legend>
        <label className={draft.mode === "none" ? "is-selected" : undefined}>
          <input
            type="radio"
            name="import-consent-mode"
            value="none"
            checked={draft.mode === "none"}
            onChange={() => onChange({ ...draft, mode: "none", scopeAcknowledged: false, typedConfirmation: "" })}
          />
          <span className="subscriber-import-choice-icon is-protected" aria-hidden="true">—</span>
          <span><strong>No positive consent proof</strong><small>New rows stay unconfirmed and non-sendable. No granted consent receipt is created.</small></span>
          <span className="subscriber-import-recommended">Recommended default</span>
        </label>
        <label className={draft.mode === "verified" ? "is-selected" : undefined}>
          <input
            type="radio"
            name="import-consent-mode"
            value="verified"
            checked={draft.mode === "verified"}
            onChange={() => update("mode", "verified")}
          />
          <span className="subscriber-import-choice-icon" aria-hidden="true">✓</span>
          <span><strong>Record verified positive consent</strong><small>Only for a complete, reviewable email-marketing grant that applies to every new row.</small></span>
        </label>
      </fieldset>

      {draft.mode === "none" ? (
        <div className="subscriber-import-protection-state" role="status">
          <span aria-hidden="true">◇</span>
          <div><strong>Protection stays on</strong><p>Importing creates no permission. Campaign eligibility can change only through a later governed consent action.</p></div>
        </div>
      ) : (
        <div className="subscriber-import-proof-form">
          <div className="subscriber-import-proof-contract" role="note">
            <span>Exact scope</span><strong>Email marketing</strong>
            <span>Legal basis</span><strong>Consent</strong>
            <span>Contract</span><code>{IMPORT_CONSENT_CONTRACT_VERSION}</code>
          </div>
          <div className="subscriber-import-form-grid">
            <label className="field-v2">
              <span>Evidence source</span>
              <select
                className="input"
                value={draft.source}
                aria-invalid={Boolean(error("source")) || undefined}
                onChange={(event) => update("source", event.target.value as ImportConsentDraft["source"])}
              >
                <option value="">Choose a source…</option>
                {IMPORT_CONSENT_SOURCES.map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}
              </select>
              {error("source") ? <small className="field-error">{error("source")}</small> : null}
            </label>
            <label className="field-v2">
              <span>Captured at</span>
              <input
                className="input"
                type="datetime-local"
                value={draft.capturedAtLocal}
                max={currentLocalDateTimeMax()}
                aria-invalid={Boolean(error("capturedAtLocal")) || undefined}
                onChange={(event) => update("capturedAtLocal", event.target.value)}
              />
              {error("capturedAtLocal") ? <small className="field-error">{error("capturedAtLocal")}</small> : null}
            </label>
            <label className="field-v2 subscriber-import-span-2">
              <span>Evidence source URL</span>
              <input
                className="input"
                type="url"
                inputMode="url"
                placeholder="https://consent.example.test/records/CONSENT-123"
                value={draft.sourceUrl}
                aria-invalid={Boolean(error("sourceUrl")) || undefined}
                onChange={(event) => update("sourceUrl", event.target.value)}
              />
              <small>HTTPS only. No embedded credentials, access codes, signatures, tokens, or secrets.</small>
              {error("sourceUrl") ? <small className="field-error">{error("sourceUrl")}</small> : null}
            </label>
            <label className="field-v2">
              <span>Jurisdiction</span>
              <input
                className="input"
                type="text"
                placeholder="US-CA"
                maxLength={32}
                value={draft.jurisdiction}
                aria-invalid={Boolean(error("jurisdiction")) || undefined}
                onChange={(event) => update("jurisdiction", event.target.value.toUpperCase())}
              />
              {error("jurisdiction") ? <small className="field-error">{error("jurisdiction")}</small> : null}
            </label>
            <label className="field-v2">
              <span>Policy version</span>
              <input
                className="input"
                type="text"
                placeholder="marketing-consent-2026-07"
                maxLength={100}
                value={draft.policyVersion}
                aria-invalid={Boolean(error("policyVersion")) || undefined}
                onChange={(event) => update("policyVersion", event.target.value)}
              />
              {error("policyVersion") ? <small className="field-error">{error("policyVersion")}</small> : null}
            </label>
            <label className="field-v2 subscriber-import-span-2">
              <span>Typed evidence reference</span>
              <input
                className="input"
                type="text"
                placeholder="receipt:CONSENT-123"
                maxLength={288}
                value={draft.evidenceReference}
                aria-invalid={Boolean(error("evidenceReference")) || undefined}
                onChange={(event) => update("evidenceReference", event.target.value)}
              />
              <small>Reference the durable record; never paste the evidence contents or a subscriber identity.</small>
              {error("evidenceReference") ? <small className="field-error">{error("evidenceReference")}</small> : null}
            </label>
            <label className="field-v2 subscriber-import-span-2">
              <span>Audit reason</span>
              <textarea
                className="input"
                rows={3}
                maxLength={500}
                placeholder="Verified against the signed acquisition record under the policy version above."
                value={draft.reason}
                aria-invalid={Boolean(error("reason")) || undefined}
                onChange={(event) => update("reason", event.target.value)}
              />
              <small>{draft.reason.length}/500 · no personal data or secrets</small>
              {error("reason") ? <small className="field-error">{error("reason")}</small> : null}
            </label>
          </div>
          <div className="subscriber-import-scope-ack">
            <label htmlFor="subscriber-import-scope-acknowledged" aria-label="Acknowledge email marketing consent scope">
              <input
                id="subscriber-import-scope-acknowledged"
                type="checkbox"
                checked={draft.scopeAcknowledged}
                aria-invalid={Boolean(error("scopeAcknowledged")) || undefined}
                onChange={(event) => update("scopeAcknowledged", event.target.checked)}
              />
              <span><strong>I verified this proof applies to every new row for {IMPORT_CONSENT_SCOPE} only.</strong><small>It does not override existing opt-outs, suppressions, or consent vectors.</small></span>
            </label>
            {error("scopeAcknowledged") ? <p className="field-error">{error("scopeAcknowledged")}</p> : null}
            <label className="field-v2">
              <span>Type <strong>{IMPORT_CONSENT_CONFIRMATION}</strong> to confirm the exact scope</span>
              <input
                className="input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={draft.typedConfirmation}
                aria-invalid={Boolean(error("typedConfirmation")) || undefined}
                onChange={(event) => update("typedConfirmation", event.target.value)}
              />
              {error("typedConfirmation") ? <small className="field-error">{error("typedConfirmation")}</small> : null}
            </label>
          </div>
        </div>
      )}
    </section>
  );
}

export function OptionsStep({
  tags,
  tagDraft,
  tagError,
  strategy,
  onTagDraft,
  onCommitTag,
  onRemoveTag,
  onStrategy,
}: {
  tags: string[];
  tagDraft: string;
  tagError: string | null;
  strategy: SubscriberImportStrategy;
  onTagDraft: (value: string) => void;
  onCommitTag: () => void;
  onRemoveTag: (value: string) => void;
  onStrategy: (value: SubscriberImportStrategy) => void;
}): ReactElement {
  const onTagKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      onCommitTag();
    }
  };
  return (
    <section className="subscriber-import-step" aria-labelledby="import-options-title">
      <header className="subscriber-import-step-heading">
        <span className="subscriber-import-eyebrow">Deterministic handling</span>
        <h3 id="import-options-title">Choose collision behavior before classification</h3>
        <p>The preflight will calculate the exact effect of this strategy against current workspace state.</p>
      </header>
      <fieldset className="subscriber-import-strategy-grid">
        <legend>When an email already exists</legend>
        {([
          ["skip", "Keep existing untouched", "No profile fields or tags are merged."],
          ["update", "Merge safe fields", "Only non-empty mapped fields and tags merge; eligibility is preserved."],
          ["error", "Require a conflict-free file", "Any existing subscriber or invalid row blocks the whole import."],
        ] as const).map(([value, title, description]) => (
          <label key={value} className={strategy === value ? "is-selected" : undefined} htmlFor={`subscriber-import-strategy-${value}`} aria-label={title}>
            <input id={`subscriber-import-strategy-${value}`} type="radio" name="import-strategy" value={value} checked={strategy === value} onChange={() => onStrategy(value)} />
            <span><strong>{title}</strong><small>{description}</small></span>
          </label>
        ))}
      </fieldset>
      <div className="subscriber-import-tags-panel">
        <div className="subscriber-import-section-title"><div><strong>Apply job-level tags</strong><span>Added after any mapped tags; duplicates collapse case-insensitively.</span></div><span>{tags.length}/{MAX_IMPORT_TAGS}</span></div>
        <div className="subscriber-import-tag-entry">
          <input
            className="input"
            type="text"
            placeholder="newsletter, launch-2026"
            value={tagDraft}
            maxLength={MAX_TAG_LENGTH + 1}
            aria-label="Add import tag"
            aria-invalid={Boolean(tagError) || undefined}
            onChange={(event) => onTagDraft(event.target.value)}
            onKeyDown={onTagKeyDown}
          />
          <button type="button" className="btn" onClick={onCommitTag} disabled={!tagDraft.trim()}>Add tag</button>
        </div>
        {tagError ? <p className="field-error" role="alert">{tagError}</p> : null}
        {tags.length ? (
          <div className="subscriber-import-tag-list" aria-label="Tags applied by this import">
            {tags.map((tag) => (
              <span key={tag}><span>{tag}</span><button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onRemoveTag(tag)}>×</button></span>
            ))}
          </div>
        ) : <p className="subscriber-import-empty-note">No job-level tags. Mapped per-row tags still apply.</p>}
      </div>
      <div className="subscriber-import-execution-note" role="note">
        <span className="subscriber-import-choice-icon" aria-hidden="true">1×</span>
        <div><strong>One-time execution</strong><p>The reviewed static file queues once after confirmation. Recurrence and pacing remain unavailable until each future source can be re-reviewed.</p></div>
      </div>
    </section>
  );
}

function fingerprintLabel(value: string | undefined): string {
  if (!value || value.length < 17) return "Not established";
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function EvidenceRow({ label, value, code = false }: { label: string; value: string; code?: boolean }): ReactElement {
  return <div><dt>{label}</dt><dd className={code ? "subscriber-import-fingerprint" : undefined}>{code ? <code>{value}</code> : value}</dd></div>;
}

export function ReviewStep({
  preview,
  preflight,
  now,
  queueAcknowledged,
  failureAcknowledged,
  onQueueAcknowledged,
  onFailureAcknowledged,
}: {
  preview: SubscriberImportPreview;
  preflight: SubscriberImportDryRunResults | null;
  now: number;
  queueAcknowledged: boolean;
  failureAcknowledged: boolean;
  onQueueAcknowledged: (value: boolean) => void;
  onFailureAcknowledged: (value: boolean) => void;
}): ReactElement {
  const fresh = importPreflightIsFresh(preflight, now);
  const expired = Boolean(preflight && !fresh);
  const proof = preview.consent_contract_state === "complete";
  const expectedReceipts = proof && preflight ? preflight.would_create + preflight.would_update : 0;
  return (
    <section className="subscriber-import-step" aria-labelledby="import-review-title">
      <header className="subscriber-import-step-heading subscriber-import-heading-row">
        <div><span className="subscriber-import-eyebrow">Authoritative gate</span><h3 id="import-review-title">Verify current state, then queue exactly once</h3><p>Preflight is exhaustive, read-only, and valid for 15 minutes. A settings, source, schema, subscriber, or suppression change requires a new review.</p></div>
        <span className={`subscriber-import-preflight-badge ${fresh ? "is-fresh" : expired ? "is-expired" : ""}`} role="status">
          <span aria-hidden="true">{fresh ? "●" : expired ? "!" : "○"}</span>{fresh ? "Verified now" : expired ? "Review expired" : "Preflight required"}
        </span>
      </header>
      <div className="subscriber-import-review-grid">
        <section aria-labelledby="import-review-contract-title">
          <h4 id="import-review-contract-title">Frozen execution contract</h4>
          <dl className="subscriber-import-evidence-list">
            <EvidenceRow label="Source" value={fingerprintLabel(preview.source_fingerprint)} code />
            <EvidenceRow label="Fingerprint key" value={preview.source_fingerprint_key_version || "Unavailable"} />
            <EvidenceRow label="Review revision" value={`r${preview.configuration_revision ?? "?"}`} code />
            <EvidenceRow label="Existing rows" value={preview.on_existing === "error" ? "Require zero conflicts" : preview.on_existing === "update" ? "Merge fields; preserve eligibility" : "Leave untouched"} />
            <EvidenceRow label="Consent" value={proof ? `Complete · ${IMPORT_CONSENT_SCOPE}` : "No positive proof · new rows protected"} />
            <EvidenceRow label="Execution" value="One-time · immediate after confirmation" />
          </dl>
        </section>
        <section aria-labelledby="import-review-classification-title">
          <h4 id="import-review-classification-title">Current classification</h4>
          <div className="subscriber-import-metric-grid">
            <ImportMetricTile label="Total rows" value={(preflight?.rows_total ?? preview.rows_total ?? 0).toLocaleString()} />
            <ImportMetricTile label="New" value={(preflight?.would_create ?? preview.rows_new ?? 0).toLocaleString()} />
            <ImportMetricTile label="Existing" value={(preview.rows_existing ?? 0).toLocaleString()} />
            <ImportMetricTile label="File duplicates" value={(preflight?.file_dupes ?? preview.rows_file_dupes ?? 0).toLocaleString()} />
            <ImportMetricTile label="Sendable after" value={preflight ? preflight.would_be_sendable.toLocaleString() : "—"} />
            <ImportMetricTile label="Protected existing" value={preflight ? preflight.would_remain_protected.toLocaleString() : "—"} />
            <ImportMetricTile label="Receipts expected" value={preflight ? expectedReceipts.toLocaleString() : "—"} />
            <ImportMetricTile label="Invalid rows" value={preflight ? preflight.would_fail.toLocaleString() : "—"} />
          </div>
        </section>
      </div>
      {preflight ? <DryRunResults results={preflight} /> : (
        <div className="subscriber-import-preflight-empty" role="note"><span aria-hidden="true">◎</span><div><strong>No live writes are available yet</strong><p>Run the exhaustive preflight to bind current subscriber, suppression, mapping, consent, and custom-field state.</p></div></div>
      )}
      {preflight ? (
        <div className="subscriber-import-preflight-provenance">
          <span>Validated <time dateTime={preflight.validated_at}>{fmtDateTime(preflight.validated_at)} · {fmtRelative(preflight.validated_at)}</time></span>
          <span>Expires <time dateTime={preflight.expires_at}>{fmtDateTime(preflight.expires_at)} · {fmtRelative(preflight.expires_at)}</time></span>
          <span>Review <code>{fingerprintLabel(preflight.preflight_fingerprint)}</code></span>
          <span>State <code>{fingerprintLabel(preflight.state_fingerprint)}</code></span>
          <span>Catalog <code>{fingerprintLabel(preflight.catalog_fingerprint)}</code></span>
        </div>
      ) : null}
      {preflight?.would_fail ? (
        <label className="subscriber-import-check-card is-warning" htmlFor="subscriber-import-failure-acknowledgement" aria-label="Acknowledge invalid preflight rows">
          <input id="subscriber-import-failure-acknowledgement" type="checkbox" checked={failureAcknowledged} onChange={(event) => onFailureAcknowledged(event.target.checked)} />
          <span><strong>I reviewed the {preflight.would_fail.toLocaleString()} invalid rows.</strong><small>{preview.on_existing === "error" ? "Conflict-free mode cannot queue until every failure and existing-row conflict is resolved." : "They will remain unchanged; valid rows can still settle independently."}</small></span>
        </label>
      ) : null}
      {fresh ? (
        <label className="subscriber-import-check-card is-final" htmlFor="subscriber-import-queue-acknowledgement" aria-label="Acknowledge authoritative preflight and queue intent">
          <input id="subscriber-import-queue-acknowledgement" type="checkbox" checked={queueAcknowledged} onChange={(event) => onQueueAcknowledged(event.target.checked)} />
          <span><strong>I reviewed this authoritative preflight and intend to queue this one-time import.</strong><small>Any server-detected drift will reject confirmation and require a fresh preflight.</small></span>
        </label>
      ) : null}
      {preview.status !== "preview" ? <ImportProgress preview={preview} /> : null}
      <p className="subscriber-import-retention-note">Review artifacts are time-bounded. Row-level error details contain row numbers and safe categories only—not email addresses or raw CSV values.</p>
    </section>
  );
}
