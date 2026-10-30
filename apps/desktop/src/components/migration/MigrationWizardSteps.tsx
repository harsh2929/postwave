import { type ReactElement, useId, useMemo, useState } from "react";

import type {
  MigrationDiscoveryReport,
  MigrationPreview,
  MigrationSourceCapability,
} from "../../lib/api-client";
import {
  applyRuntimeMigrationCapability,
  type ConnectionValues as ConnValues,
  type MigrationSourceDef,
  MIGRATION_SOURCES,
} from "../../lib/migration-sources";
import { MigrationFileFieldInput } from "./MigrationFileFieldInput";
import {
  MAX_MIGRATION_UPLOAD_BYTES,
  MIGRATION_IMPORT_POLICY,
  SUBSTACK_MIGRATION_IMPORT_POLICY,
} from "./migration-file-policy";

export function SourcePickStep({
  capabilities,
  capabilitiesErr,
  stale,
  refreshing,
  onRetry,
  onPick,
}: {
  capabilities: MigrationSourceCapability[] | null;
  capabilitiesErr: string | null;
  stale: boolean;
  refreshing: boolean;
  onRetry: () => void;
  onPick: (s: MigrationSourceDef) => void;
}): ReactElement {
  const searchId = useId();
  const viewId = useId();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<
    "all" | "ready" | "dry_run" | "blocked" | "oauth" | "api_key" | "file"
  >("all");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const catalog = useMemo(
    () =>
      MIGRATION_SOURCES.map((staticSource) => {
        const capability = capabilities?.find(
          (item) => item.source === staticSource.id,
        );
        return {
          source: applyRuntimeMigrationCapability(staticSource, capability),
          capability,
        };
      }).filter(({ source, capability }) => {
        const blocked =
          !source.serverSupport || source.intakeAvailable === false;
        const matchesView =
          view === "all" ||
          (view === "ready" && !blocked && source.commitAvailable === true) ||
          (view === "dry_run" && !blocked && source.commitAvailable !== true) ||
          (view === "blocked" && blocked) ||
          (view === "oauth" && capability?.auth_method === "oauth2") ||
          (view === "api_key" && capability?.auth_method === "api_key") ||
          (view === "file" && capability?.auth_method === "csv_upload");
        if (!matchesView) return false;
        if (!normalizedQuery) return true;
        return [
          source.name,
          source.id,
          source.tagline,
          sourcePickerResourceSummary(capability),
        ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      }),
    [capabilities, normalizedQuery, view],
  );
  if (capabilities == null) {
    return (
      <div className="wizard-action-row" role="status">
        <div className="skel" style={{ height: 72 }} />
        <p className="muted">Loading migration adapters from the server…</p>
      </div>
    );
  }
  return (
    <>
      <MigrationCapabilityNotice
        error={capabilitiesErr}
        stale={stale}
        refreshing={refreshing}
        onRetry={onRetry}
      />
      <div className="wizard-source-controls">
        <div className="field">
          <label className="field-label" htmlFor={searchId}>
            Search source platforms
          </label>
          <input
            id={searchId}
            className="input"
            type="search"
            value={query}
            placeholder="Platform or resource"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={viewId}>
            Compatibility view
          </label>
          <select
            id={viewId}
            className="select"
            value={view}
            onChange={(event) => setView(event.target.value as typeof view)}
          >
            <option value="all">All platforms</option>
            <option value="ready">Write-ready</option>
            <option value="dry_run">Dry-run only</option>
            <option value="blocked">Unavailable</option>
            <option value="oauth">OAuth</option>
            <option value="api_key">API credential</option>
            <option value="file">File upload</option>
          </select>
        </div>
      </div>
      <p className="wizard-source-result-count" aria-live="polite">
        {catalog.length.toLocaleString()} of{" "}
        {MIGRATION_SOURCES.length.toLocaleString()} platforms shown
      </p>
      {catalog.length === 0 ? (
        <div className="migration-empty-panel" role="status">
          <strong>No platform matches this view.</strong>
          <span>Clear the search or choose another compatibility filter.</span>
        </div>
      ) : (
        <div className="wizard-source-grid">
          {catalog.map(({ source: s, capability }) => {
            const blockedReason = !s.serverSupport
              ? (s.runtimeCompatibilityError ??
                "Not registered on this deployment")
              : s.intakeAvailable === false
                ? (s.intakeUnavailableReason ?? "Safe setup is unavailable")
                : stale
                  ? "Capability verification is stale"
                  : null;
            const posture = blockedReason
              ? "Unavailable"
              : s.commitAvailable === true
                ? "Write-ready"
                : "Dry-run only";
            return (
              <button
                key={s.id}
                type="button"
                className={`wizard-source-card${blockedReason ? " is-unavailable" : ""}`}
                aria-label={
                  blockedReason
                    ? `${s.name} unavailable: ${blockedReason}`
                    : `${s.name} · ${sourcePickerAuthLabel(s)} · ${posture}`
                }
                aria-disabled={Boolean(blockedReason) || undefined}
                onClick={() => {
                  if (!blockedReason) onPick(s);
                }}
              >
                <div
                  className="wizard-source-logo"
                  aria-hidden
                  style={{
                    background: s.color,
                    // eslint-disable-next-line no-restricted-syntax -- contrast-pair text on a brand-color background; the pair is computed per source, not theme-dependent
                    color: s.darkText ? "#0a0a0a" : "#ffffff",
                  }}
                >
                  {s.initials}
                </div>
                <div className="wizard-source-name">{s.name}</div>
                <div className="wizard-source-tag">
                  {sourcePickerResourceSummary(capability)}
                </div>
                <span
                  className={`wizard-source-badge${posture === "Write-ready" ? " is-ready" : posture === "Dry-run only" ? " is-review" : " is-blocked"}`}
                >
                  {posture}
                </span>
                <span className="wizard-source-auth">
                  {sourcePickerAuthLabel(s)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

function sourcePickerAuthLabel(source: MigrationSourceDef): string {
  if (source.authFlow === "oauth") return "OAuth";
  if (source.authFlow === "csv_upload") return "File upload";
  if (source.authFlow === "api_key") return "API credential";
  return "Assisted review";
}

function sourcePickerResourceSummary(
  capability: MigrationSourceCapability | undefined,
): string {
  if (!capability) return "No verified adapter contract";
  const labels: Array<
    [keyof NonNullable<MigrationSourceCapability["supports"]>, string]
  > = [
    ["subscribers", "Subscribers"],
    ["segments", "Segments"],
    ["templates", "Templates"],
    ["campaign_archive", "History"],
    ["consent_timestamps", "Consent evidence"],
    ["crm", "CRM evidence"],
    ["custom_objects", "Object evidence"],
  ];
  const supported = labels
    .filter(([key]) => capability.supports?.[key] === true)
    .map(([, label]) => label);
  if (supported.length === 0) return "Coverage verified during preflight";
  const shown = supported.slice(0, 3);
  const remainder = supported.length - shown.length;
  return `${shown.join(" · ")}${remainder > 0 ? ` · +${remainder}` : ""}`;
}

export function MigrationCapabilityNotice({
  error,
  stale,
  refreshing,
  onRetry,
}: {
  error: string | null;
  stale: boolean;
  refreshing: boolean;
  onRetry: () => void;
}): ReactElement | null {
  if (!error) return null;
  return (
    <div className="notice migration-capability-notice" role="alert">
      <span>{error}</span>
      {stale ? (
        <span>
          No connection can start until a fresh catalog is verified. Any source
          cards shown are retained only for context.
        </span>
      ) : null}
      <button
        type="button"
        className="btn btn-sm"
        aria-disabled={refreshing || undefined}
        aria-busy={refreshing || undefined}
        aria-describedby={
          refreshing ? "migration-capability-refresh-reason" : undefined
        }
        onClick={() => {
          if (!refreshing) onRetry();
        }}
      >
        {refreshing ? "Retrying…" : "Retry capability check"}
      </button>
      {refreshing ? (
        <span
          id="migration-capability-refresh-reason"
          className="migration-action-reason"
          role="status"
        >
          A capability check is already in progress.
        </span>
      ) : null}
    </div>
  );
}

/* ====================================================================
 * Step 2: connect
 * ================================================================== */

interface ConnectStepProps {
  source: MigrationSourceDef;
  values: ConnValues;
  setValues: (next: ConnValues) => void;
  showSecrets: Record<string, boolean>;
  setShowSecrets: (next: Record<string, boolean>) => void;
  err: string | null;
  discovery: MigrationDiscoveryReport | null;
  selectedAudienceIds: string[];
  setSelectedAudienceIds: (ids: string[]) => void;
  oauthWaiting: boolean;
  onCancelOAuth: () => void;
}

export function ConnectStep({
  source,
  values,
  setValues,
  showSecrets,
  setShowSecrets,
  err,
  discovery,
  selectedAudienceIds,
  setSelectedAudienceIds,
  oauthWaiting,
  onCancelOAuth,
}: ConnectStepProps): ReactElement {
  if (!source.serverSupport || source.intakeAvailable === false) {
    const compatibilityError = source.runtimeCompatibilityError;
    const intakeUnavailableReason = source.intakeUnavailableReason;
    return (
      <>
        <div className="notice" role="alert">
          <span>
            <strong>
              {compatibilityError
                ? "Desktop update required."
                : intakeUnavailableReason
                  ? "Source setup is unavailable."
                  : "Source is not available on this deployment."}
            </strong>{" "}
            {compatibilityError ??
              intakeUnavailableReason ??
              `The ${source.name} adapter is not registered on this Moosewave server.`}
          </span>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          {compatibilityError
            ? "No credential field or browser handoff is offered because guessing an authorization contract could submit an empty or incorrectly shaped secret."
            : intakeUnavailableReason
              ? "No file or credential is accepted from this screen until the deployment reports a durable setup path."
              : source.id === "other"
                ? "No request is sent from this screen. Ask your Moosewave contact to assess the source export and confirm a supported migration plan before sharing credentials."
                : "This desktop build cannot verify the adapter on the current server. Ask a workspace administrator to confirm server configuration before sharing credentials."}
        </p>
      </>
    );
  }
  return (
    <>
      <p className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
        {source.authFlow === "oauth"
          ? `Authorization and the rest of this ${source.name} migration run in the hosted workspace. The desktop never receives the provider token and does not infer ownership from other administrators' tenant-wide jobs.`
          : "Moosewave stores credentials encrypted at rest. Credentials stay tenant-scoped and are retained only for the migration session."}
      </p>
      {oauthWaiting ? (
        <div className="notice" role="status" style={{ gap: 12 }}>
          <span>
            The hosted migration workspace is open. Complete authorization,
            preflight, and import there. When finished, close this window and
            refresh migration history; this desktop will not auto-attach an
            unbound job.
          </span>
          <button type="button" className="btn" onClick={onCancelOAuth}>
            Return to source setup
          </button>
        </div>
      ) : null}
      {source.fields.map((f) => (
        <FieldInput
          key={f.key}
          source={source}
          field={f}
          value={values[f.key]}
          onChange={(v) => setValues({ ...values, [f.key]: v })}
          showSecret={Boolean(showSecrets[f.key])}
          onToggleSecret={() =>
            setShowSecrets({ ...showSecrets, [f.key]: !showSecrets[f.key] })
          }
        />
      ))}
      {source.id === "mailchimp" && discovery ? (
        <AudienceSelection
          audiences={discovery.audiences ?? []}
          selectedIds={selectedAudienceIds}
          onChange={setSelectedAudienceIds}
        />
      ) : null}
      {err ? (
        <div className="field-error" role="alert">
          {err}
        </div>
      ) : null}
    </>
  );
}

function AudienceSelection({
  audiences,
  selectedIds,
  onChange,
}: {
  audiences: NonNullable<MigrationDiscoveryReport["audiences"]>;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}): ReactElement {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleAudiences = useMemo(
    () =>
      normalizedQuery
        ? audiences.filter((audience) =>
            [audience.name, audience.id].some((value) =>
              value?.toLocaleLowerCase().includes(normalizedQuery),
            ),
          )
        : audiences,
    [audiences, normalizedQuery],
  );
  const allVisibleSelected =
    visibleAudiences.length > 0 &&
    visibleAudiences.every((item) => selectedIds.includes(item.id));
  const toggle = (id: string): void => {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((item) => item !== id)
        : [...selectedIds, id],
    );
  };
  return (
    <fieldset className="wizard-risk" style={{ marginTop: 16 }}>
      <legend className="wizard-risk-title">Choose Mailchimp audiences</legend>
      <p className="muted" style={{ fontSize: 12 }}>
        The same explicit scope is used for discovery, dry-run, and commit. It
        limits audience-bound contacts, groups/interests, segments, signup-form
        and audience-schema evidence, Classic Automations, campaigns, and
        reports. Templates, landing pages, and ecommerce evidence are
        account-wide; other source-archive guidance is account-global or
        non-detected, and all of it is labeled for review.
      </p>
      <p className="migration-selection-summary" role="status">
        {selectedIds.length.toLocaleString()} of{" "}
        {audiences.length.toLocaleString()} source audiences selected
      </p>
      <div className="field migration-audience-search">
        <label className="field-label" htmlFor={searchId}>
          Find an audience
        </label>
        <input
          id={searchId}
          className="input"
          type="search"
          value={query}
          placeholder="Audience name or source ID"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <label className="migration-audience-option is-select-all">
        <input
          type="checkbox"
          checked={allVisibleSelected}
          onChange={() => {
            const visibleIds = new Set(
              visibleAudiences.map((audience) => audience.id),
            );
            onChange(
              allVisibleSelected
                ? selectedIds.filter((id) => !visibleIds.has(id))
                : Array.from(
                    new Set([
                      ...selectedIds,
                      ...visibleAudiences.map((audience) => audience.id),
                    ]),
                  ),
            );
          }}
        />
        {normalizedQuery ? "Select all matching" : "Select all"} (
        {visibleAudiences.length})
      </label>
      <div className="migration-audience-options">
        {visibleAudiences.length === 0 ? (
          <p className="muted" role="status">
            No audience matches this search. Existing selections are retained.
          </p>
        ) : (
          visibleAudiences.map((audience) => (
            <label key={audience.id} className="migration-audience-option">
              <input
                type="checkbox"
                checked={selectedIds.includes(audience.id)}
                onChange={() => toggle(audience.id)}
              />
              <span className="migration-audience-identity">
                <span>{audience.name || "Unnamed audience"}</span>
                <code>{audience.id}</code>
              </span>
              <span className="muted tabular migration-audience-count">
                {audience.subscribers_total.toLocaleString()} contacts
              </span>
            </label>
          ))
        )}
      </div>
    </fieldset>
  );
}

interface FieldInputProps {
  source: MigrationSourceDef;
  field: MigrationSourceDef["fields"][number];
  value: string | File | null | undefined;
  onChange: (v: string | File | null) => void;
  showSecret: boolean;
  onToggleSecret: () => void;
}

function FieldInput({
  source,
  field,
  value,
  onChange,
  showSecret,
  onToggleSecret,
}: FieldInputProps): ReactElement {
  const id = `wiz-${source.id}-${field.key.replace(/[^a-z0-9]/gi, "_")}`;
  const helpId = `${id}-help`;
  if (field.kind === "file") {
    return (
      <MigrationFileFieldInput
        id={id}
        label={field.label}
        required={Boolean(field.required)}
        help={field.help}
        file={value instanceof File ? value : null}
        policy={
          source.id === "substack"
            ? SUBSTACK_MIGRATION_IMPORT_POLICY
            : MIGRATION_IMPORT_POLICY
        }
        maxBytes={MAX_MIGRATION_UPLOAD_BYTES}
        onChange={onChange}
      />
    );
  }
  if (field.kind === "textarea") {
    return (
      <div className="field" key={field.key}>
        <label className="field-label" htmlFor={id}>
          {field.label}
          {field.required ? " *" : ""}
        </label>
        <textarea
          id={id}
          className="input"
          rows={4}
          placeholder={field.placeholder ?? ""}
          maxLength={field.maxLength}
          required={field.required}
          aria-required={field.required || undefined}
          aria-describedby={field.help ? helpId : undefined}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          style={{ resize: "vertical" }}
        />
        {field.help ? (
          <FieldHelpDisclosure id={helpId} text={field.help} />
        ) : null}
      </div>
    );
  }
  const isSecret = field.kind === "password";
  const inputType =
    field.kind === "password"
      ? showSecret
        ? "text"
        : "password"
      : field.kind === "url"
        ? "url"
        : field.kind === "email"
          ? "email"
          : "text";
  return (
    <div className="field" key={field.key}>
      <label className="field-label" htmlFor={id}>
        {field.label}
        {field.required ? " *" : ""}
      </label>
      <div style={{ position: "relative" }}>
        <input
          id={id}
          type={inputType}
          className="input"
          placeholder={field.placeholder ?? ""}
          maxLength={field.maxLength}
          required={field.required}
          aria-required={field.required || undefined}
          aria-describedby={field.help ? helpId : undefined}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          style={isSecret ? { paddingRight: 56 } : undefined}
        />
        {isSecret ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={`${showSecret ? "Hide" : "Show"} ${field.label}`}
            onClick={onToggleSecret}
            style={{
              position: "absolute",
              top: 1,
              right: 1,
              height: 28,
            }}
          >
            {showSecret ? "Hide" : "Show"}
          </button>
        ) : null}
      </div>
      {field.help ? (
        <FieldHelpDisclosure id={helpId} text={field.help} />
      ) : null}
    </div>
  );
}

function FieldHelpDisclosure({
  id,
  text,
}: {
  id: string;
  text: string;
}): ReactElement {
  return (
    <details id={id} className="migration-field-help-disclosure">
      <summary>Credential access and source scope</summary>
      <p>{text}</p>
    </details>
  );
}

/* ====================================================================
 * Step 3: preview
 * ================================================================== */

interface PreviewStepProps {
  source: MigrationSourceDef;
  preview: MigrationPreview | null;
  busy: boolean;
  err: string | null;
}

export function PreviewStep({
  source,
  preview,
  busy,
  err,
}: PreviewStepProps): ReactElement {
  if (err) {
    return (
      <>
        <div className="notice">
          <strong>Dry-run failed.</strong>
          <span style={{ marginLeft: 8 }}>{err}</span>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          Step back to fix credentials and try again. No data has been imported
          yet.
        </p>
      </>
    );
  }
  if (busy || !preview) {
    return (
      <div className="wizard-action-row">
        <div className="skel" style={{ height: 14, width: "70%" }} />
        <div className="skel" style={{ height: 14, width: "55%" }} />
        <div className="skel" style={{ height: 14, width: "85%" }} />
        <div className="skel" style={{ height: 14, width: "65%" }} />
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Reading from {source.name}… this usually takes 10–30 seconds.
        </p>
      </div>
    );
  }
  return (
    <div className="migration-truth-callout is-limited" role="alert">
      <strong>The dry-run report cannot be linked to an exact job.</strong>
      <span>
        No real import can start from this state. Step back and prepare a new
        dry-run so the report and job identifier can be verified together.
      </span>
    </div>
  );
}
