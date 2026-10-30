import { type ReactElement } from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { AccessibleChartData } from "../components/charts/AccessibleChartData";
import { dux025Provenance } from "../components/charts/dux-025-visual-manifest";
import { FrequencyCapsCard } from "../components/deliverability/FrequencyCapsCard";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { InlineHelp } from "../components/InlineHelp";
import { PageHeader } from "../components/PageHeader";
import { RemoteDataNotice } from "../components/RemoteDataNotice";
import { SaveBar } from "../components/settings/SaveBar";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { SENDING_TIMEZONES } from "../lib/api-client";
import { useDesktopRouteTab } from "../lib/desktop-router";
import { HERO } from "../lib/heroAssets";
import { describeIpPool } from "../lib/settings-gates";
import { setSection } from "../lib/store";
import {
  changedSendingFields,
  sendingSettingsAreConfigured,
  sendingStatusMatchesSettings,
  timeZoneOptions,
  type SendingFormState,
  type VerifiedSendingSettings,
  type VerifiedSendingStatus,
} from "./sending-settings-model";
import {
  useSendingSettingsController,
  type SendingSettingsController,
  type SendingSettingsTab,
} from "./useSendingSettingsController";

import "../styles-sending-settings.css";

const TABS: ReadonlyArray<{
  value: SendingSettingsTab;
  label: string;
  hint: string;
}> = [
  { value: "overview", label: "Overview", hint: "Current configuration" },
  { value: "limits", label: "Limits & quiet hours", hint: "Workspace policy" },
  { value: "frequency", label: "Frequency caps", hint: "Recipient admission" },
  { value: "identity", label: "Sending identity", hint: "Routing context" },
];
const TAB_VALUES = TABS.map((tab) => tab.value);

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formattedDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    : null;
}

function LastUpdated({ value }: { value: string | null }): ReactElement | null {
  const label = formattedDate(value);
  return label && value ? (
    <time className="sending-updated" dateTime={value}>
      Updated {label}
    </time>
  ) : null;
}

function AccessBoundary({
  roleStatus,
  accessDenialReason,
}: {
  roleStatus: SendingSettingsController["roleStatus"];
  accessDenialReason: SendingSettingsController["accessDenialReason"];
}): ReactElement {
  const loading = roleStatus === "loading";
  return (
    <section
      className="sending-access-boundary"
      aria-labelledby="sending-access-title"
      aria-busy={loading ? "true" : undefined}
    >
      {loading ? (
        <div className="sending-access-lock" aria-hidden="true" />
      ) : null}
      <div>
        <span className="sending-eyebrow">Admin workspace</span>
        <h2 id="sending-access-title">
          {loading
            ? "Verifying access…"
            : accessDenialReason === "credential-identity-unverified"
              ? "Credential identity not verified"
              : "Admin access required"}
        </h2>
        <p>
          {loading
            ? "Sending policy stays hidden until your workspace role is verified."
            : accessDenialReason === "credential-identity-unverified"
              ? "Moosewave verified your admin role but could not bind this view to the exact API key. Re-enter or reconnect the key, then try again."
              : roleStatus === "unavailable"
                ? "Moosewave could not verify your role. Reconnect your session, then try again."
                : "Only workspace admins can view or change sending policy and infrastructure details."}
        </p>
      </div>
    </section>
  );
}

function StatusSkeleton(): ReactElement {
  return (
    <div
      className="sending-status-grid"
      aria-label="Loading operational status"
    >
      {[0, 1, 2, 3].map((item) => (
        <div className="sending-status-card" key={item}>
          <div className="skel" style={{ width: "42%", height: 12 }} />
          <div className="skel" style={{ width: "68%", height: 24 }} />
          <div className="skel" style={{ width: "88%", height: 11 }} />
        </div>
      ))}
    </div>
  );
}

function CounterCard({
  baseline,
  status,
}: {
  baseline: VerifiedSendingSettings;
  status: VerifiedSendingStatus | null;
}): ReactElement {
  const cap = status?.max_sends_per_hour ?? baseline.max_sends_per_hour;
  const authoritative = Boolean(
    cap &&
    status?.counter_authoritative &&
    status.bucket_count !== null &&
    status.counter_scope === "shared",
  );
  const count = authoritative ? (status?.bucket_count ?? 0) : null;
  const ratio = count !== null && cap ? Math.min(1, count / cap) : 0;
  const utilization = count !== null && cap ? (count / cap) * 100 : null;
  return (
    <article className="sending-status-card">
      <span className="sending-status-label">Hourly ceiling</span>
      <strong className="sending-status-value">
        {cap ? formatCount(cap) : "No workspace ceiling"}
      </strong>
      {authoritative && count !== null && cap ? (
        <>
          <meter
            className="sending-meter"
            min={0}
            max={cap}
            value={Math.min(count, cap)}
            aria-label={`${formatCount(count)} of ${formatCount(cap)} sends counted in the current hour`}
          />
          <span className="sending-status-detail">
            {formatCount(count)} counted · {Math.round(ratio * 100)}% of ceiling
          </span>
          <AccessibleChartData
            title="Hourly sending rate-limit usage"
            summary={`${formatCount(count)} sends have been counted against the current ${formatCount(cap)}-send workspace ceiling.`}
            rowHeaderLabel="Counter window"
            columns={[
              { key: "count", label: "Sends counted" },
              { key: "limit", label: "Hourly limit" },
              { key: "utilization", label: "Utilization (%)" },
              { key: "reset", label: "Window resets" },
            ]}
            rows={[
              {
                key: "current-hour",
                label: "Current authoritative bucket",
                values: {
                  count: formatCount(count),
                  limit: formatCount(cap),
                  utilization: `${utilization?.toFixed(1) ?? "0.0"}%`,
                  reset:
                    formattedDate(status?.window_resets_at ?? null) ??
                    "Not supplied",
                },
                exportValues: {
                  count,
                  limit: cap,
                  utilization,
                  reset: status?.window_resets_at ?? null,
                },
              },
            ]}
            provenance={dux025Provenance("sendingRateLimit", {
              scope: `${status?.window_start ?? "Unspecified start"} to ${status?.window_resets_at ?? "unspecified reset"} · shared workspace counter`,
            })}
            exportFileName="hourly-sending-rate-limit.csv"
            exportPrivacy="confidential"
          />
        </>
      ) : (
        <span className="sending-status-detail">
          {cap
            ? "Live shared-counter telemetry is unavailable; no usage value is inferred."
            : "No workspace-specific hourly ceiling is configured; provider, quota, and safety controls still apply."}
        </span>
      )}
    </article>
  );
}

function QuietStatusCard({
  baseline,
  status,
}: {
  baseline: VerifiedSendingSettings;
  status: VerifiedSendingStatus | null;
}): ReactElement {
  const hasQuiet = Boolean(
    baseline.quiet_hours_start &&
    baseline.quiet_hours_end &&
    baseline.quiet_hours_tz,
  );
  const known = hasQuiet && status?.in_quiet_hours !== null && status !== null;
  const state = known
    ? status.in_quiet_hours
      ? "In quiet hours"
      : "Outside quiet hours"
    : hasQuiet
      ? "State unavailable"
      : "Not configured";
  const scope = baseline.quiet_hours_per_recipient
    ? "The state shown is the workspace-timezone fallback; individual recipients can differ."
    : "The workspace timezone applies to every recipient.";
  return (
    <article className="sending-status-card">
      <span className="sending-status-label">Quiet-hours evaluation</span>
      <strong className="sending-status-value">{state}</strong>
      <span className="sending-status-detail">
        {hasQuiet
          ? `${baseline.quiet_hours_start}–${baseline.quiet_hours_end} · ${baseline.quiet_hours_tz}. ${scope}`
          : "Outbound mail is not paused by a workspace quiet-hours window."}
      </span>
    </article>
  );
}

function CounterEvidenceCard({
  status,
  demo,
}: {
  status: VerifiedSendingStatus | null;
  demo: boolean;
}): ReactElement {
  const verified = Boolean(
    status?.counter_authoritative && status.counter_scope === "shared",
  );
  return (
    <article className="sending-status-card">
      <span className="sending-status-label">Status evidence</span>
      <strong className="sending-status-value">
        {demo
          ? "Illustrative fixture"
          : verified
            ? "Shared counter verified"
            : "Configuration only"}
      </strong>
      <span className="sending-status-detail">
        {demo
          ? "These values come from the local demo fixture, not live workspace telemetry."
          : verified
            ? `Source: ${status?.counter_source ?? "qualified server counter"}. Refreshes every 30 seconds while visible.`
            : "Moosewave will not label a legacy or process-local projection as live workspace usage."}
      </span>
    </article>
  );
}

function CapCoordinationCard({
  baseline,
  status,
  demo,
}: {
  baseline: VerifiedSendingSettings;
  status: VerifiedSendingStatus | null;
  demo: boolean;
}): ReactElement {
  const policyAligned = Boolean(
    status && sendingStatusMatchesSettings(status, baseline),
  );
  let value = "Verification unavailable";
  let detail =
    "The shared send-admission authority could not be verified. This is policy evidence, not hourly usage telemetry.";

  if (demo) {
    value = "Illustrative authority";
    detail =
      "The demo fixture depicts a synchronized policy; it does not inspect a live shared authority or counter.";
  } else if (status && !policyAligned) {
    value = "Revision mismatch";
    detail =
      "The status receipt describes a different saved policy. Refresh before relying on its operational state.";
  } else if (
    status?.cap_coordination_state === "ready" &&
    status.cap_coordination_ready &&
    status.cap_coordination_matches_settings
  ) {
    value = "Policy synchronized";
    detail =
      "The saved hourly ceiling and shared send-admission authority agree. This does not report how much of the ceiling has been used.";
  } else if (status?.cap_coordination_state === "conservatively_fenced") {
    value = "Conservatively fenced";
    detail =
      "A cap change is being reconciled, so new send admission fails closed until the shared authority is ready.";
  } else if (status?.cap_coordination_state === "ready") {
    value = "Revision mismatch";
    detail =
      "The shared authority is reachable but does not confirm this saved hourly ceiling. Refresh before making another change.";
  }

  return (
    <article className="sending-status-card">
      <span className="sending-status-label">Shared cap authority</span>
      <strong className="sending-status-value">{value}</strong>
      <span className="sending-status-detail">{detail}</span>
    </article>
  );
}

function OperationalStatus({
  controller,
}: {
  controller: SendingSettingsController;
}): ReactElement {
  const { baseline, status, statusResource } = controller;
  if (!baseline) return <StatusSkeleton />;
  const statusIsCurrent =
    !statusResource.stale && statusResource.transport !== "error";
  const alignedStatus =
    statusIsCurrent && status && sendingStatusMatchesSettings(status, baseline)
      ? status
      : null;
  const statusLagging =
    statusIsCurrent && status !== null && alignedStatus === null;
  return (
    <section aria-labelledby="sending-status-heading">
      <div className="sending-section-heading">
        <div>
          <span className="sending-eyebrow">Operational snapshot</span>
          <h2 id="sending-status-heading">
            {controller.readOnlyDemo
              ? "Illustrative demo snapshot"
              : "What Moosewave can verify now"}
          </h2>
        </div>
        <span className="sending-evidence-chip">
          {controller.readOnlyDemo
            ? "Demo fixture"
            : alignedStatus?.counter_authoritative
              ? "Qualified telemetry"
              : "Configuration only"}
        </span>
      </div>
      <RemoteDataNotice
        resource={statusResource}
        label="sending status"
        onRetry={() => void statusResource.reload()}
      />
      {statusLagging ? (
        <div className="notice sending-truth-note" role="status">
          Operational status has not caught up to this policy. Configuration is
          shown without shared-cap authority, a live quiet-hours state, or a
          counter until both reads align.
        </div>
      ) : null}
      {controller.readOnlyDemo ? (
        <div className="notice sending-demo-notice" role="note">
          Counts and operational states below are local examples. They do not
          verify a live shared counter, gateway, or workspace.
        </div>
      ) : null}
      {statusResource.data === null &&
      statusResource.transport === "loading" ? (
        <StatusSkeleton />
      ) : (
        <div className="sending-status-grid">
          <CounterCard baseline={baseline} status={alignedStatus} />
          <CapCoordinationCard
            baseline={baseline}
            status={statusIsCurrent ? status : null}
            demo={controller.readOnlyDemo}
          />
          <QuietStatusCard baseline={baseline} status={alignedStatus} />
          <CounterEvidenceCard
            status={alignedStatus}
            demo={controller.readOnlyDemo}
          />
        </div>
      )}
    </section>
  );
}

function ConfiguredSummary({
  baseline,
  onOpen,
}: {
  baseline: VerifiedSendingSettings;
  onOpen: (tab: SendingSettingsTab) => void;
}): ReactElement {
  const pool = describeIpPool(baseline.ip_pool);
  const quiet = Boolean(baseline.quiet_hours_start);
  return (
    <section
      className="sending-summary"
      aria-labelledby="sending-summary-heading"
    >
      <div className="sending-section-heading">
        <div>
          <span className="sending-eyebrow">Policy baseline</span>
          <h2 id="sending-summary-heading">Saved workspace configuration</h2>
        </div>
        <LastUpdated value={baseline.updated_at} />
      </div>
      <dl className="sending-summary-list">
        <div>
          <dt>Hourly ceiling</dt>
          <dd>
            {baseline.max_sends_per_hour
              ? `${formatCount(baseline.max_sends_per_hour)} messages`
              : "No workspace hourly ceiling"}
          </dd>
        </div>
        <div>
          <dt>Quiet hours</dt>
          <dd>
            {quiet
              ? `${baseline.quiet_hours_start}–${baseline.quiet_hours_end} · ${baseline.quiet_hours_tz}`
              : "Not configured"}
          </dd>
        </div>
        <div>
          <dt>Timezone scope</dt>
          <dd>
            {quiet && baseline.quiet_hours_per_recipient
              ? "Per recipient; workspace fallback for missing values"
              : quiet
                ? "Workspace timezone"
                : "Not applicable"}
          </dd>
        </div>
        <div>
          <dt>Reported IP assignment</dt>
          <dd>
            {pool.kind === "known"
              ? `${pool.name} · ${pool.dedicated ? "dedicated" : "shared"}`
              : "Not reported by this server"}
          </dd>
        </div>
      </dl>
      <div className="sending-summary-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onOpen("limits")}
        >
          Review policy
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onOpen("identity")}
        >
          Review routing context
        </button>
      </div>
    </section>
  );
}

function OverviewPanel({
  controller,
  onOpen,
}: {
  controller: SendingSettingsController;
  onOpen: (tab: SendingSettingsTab) => void;
}): ReactElement {
  const { baseline, settingsResource } = controller;
  const configured = baseline ? sendingSettingsAreConfigured(baseline) : false;
  return (
    <div className="sending-panel-stack">
      <RemoteDataNotice
        resource={settingsResource}
        label="sending settings"
        onRetry={() => void settingsResource.reload()}
      />
      {settingsResource.data === null &&
      settingsResource.transport === "loading" ? (
        <StatusSkeleton />
      ) : null}
      {settingsResource.data === null &&
      settingsResource.transport === "error" ? (
        <section
          className="sending-unverified"
          aria-labelledby="sending-unverified-title"
        >
          <span className="sending-eyebrow">No verified baseline</span>
          <h2 id="sending-unverified-title">The editor is staying closed</h2>
          <p>
            Moosewave could not verify the saved policy. Retry the read before
            making changes; an empty form here would be unsafe.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void settingsResource.reload()}
          >
            Retry settings read
          </button>
        </section>
      ) : null}
      {baseline && !configured ? (
        <HeroEmptyState
          tone="blue"
          eyebrow="Delivery policy"
          title="Set a deliberate sending rhythm."
          subtitle="Add a workspace ceiling or quiet-hours window without changing recipient frequency caps or your sending identity."
          imageSrc={HERO.sending}
          imageAlt=""
          primaryCta={{
            label: "Configure policy",
            onClick: () => onOpen("limits"),
          }}
          secondaryCta={{
            label: "Review frequency caps",
            onClick: () => onOpen("frequency"),
          }}
          meta="Defaults remain active until an admin saves a policy."
        />
      ) : null}
      {baseline ? <OperationalStatus controller={controller} /> : null}
      {baseline && configured ? (
        <ConfiguredSummary baseline={baseline} onOpen={onOpen} />
      ) : null}
    </div>
  );
}

function FieldError({
  id,
  message,
}: {
  id: string;
  message?: string;
}): ReactElement | null {
  return message ? (
    <span className="field-error" id={id} role="alert">
      {message}
    </span>
  ) : null;
}

function LimitsForm({
  controller,
}: {
  controller: SendingSettingsController;
}): ReactElement {
  const {
    baseline,
    form,
    fieldErrors,
    mutationError,
    mutationUncertain,
    pendingRemote,
    readOnlyDemo,
    saving,
    settingsResource,
    setForm,
  } = controller;
  if (!baseline) {
    return (
      <div className="sending-panel-stack">
        <RemoteDataNotice
          resource={settingsResource}
          label="sending settings"
          onRetry={() => void settingsResource.reload()}
        />
        {settingsResource.transport === "loading" ? (
          <StatusSkeleton />
        ) : (
          <section className="sending-unverified">
            <h2>No verified policy to edit</h2>
            <p>
              Retry the settings read. Moosewave will not substitute a blank
              draft.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void settingsResource.reload()}
            >
              Retry settings read
            </button>
          </section>
        )}
      </div>
    );
  }
  const disabled = saving || readOnlyDemo || mutationUncertain;
  const options = timeZoneOptions(form.timezone, SENDING_TIMEZONES);
  const configured = sendingSettingsAreConfigured(baseline);
  return (
    <div className="sending-panel-stack">
      <RemoteDataNotice
        resource={settingsResource}
        label="sending settings"
        onRetry={() => void settingsResource.reload()}
      />
      {readOnlyDemo ? (
        <div className="notice sending-demo-notice" role="note">
          <strong>Read-only demo.</strong> These controls show a coherent
          example policy; this build never sends mutations.
        </div>
      ) : null}
      {pendingRemote ? (
        <div className="notice sending-conflict-notice" role="alert">
          <span>
            <strong>A newer server version is available.</strong> Your draft is
            still intact. Review or discard it before adopting the new baseline.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={saving}
            onClick={controller.adoptPendingRemote}
          >
            Discard draft and load server version
          </button>
        </div>
      ) : null}
      {mutationError ? (
        <div
          className="notice notice-error sending-mutation-notice"
          role="alert"
        >
          <span>{mutationError}</span>
          {mutationUncertain ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={controller.refreshing}
              onClick={() => void controller.refresh()}
            >
              {controller.refreshing ? "Reconciling…" : "Refresh to reconcile"}
            </button>
          ) : null}
        </div>
      ) : null}
      <section
        className="sending-editor"
        aria-labelledby="sending-editor-heading"
      >
        <div className="sending-section-heading">
          <div>
            <span className="sending-eyebrow">Workspace policy</span>
            <h2 id="sending-editor-heading">Limits & quiet hours</h2>
            <p>
              The saved policy updates as one revision. Success is reported only
              after the shared sending authority confirms a new hourly ceiling;
              ambiguous saves stay held for reconciliation.
            </p>
          </div>
          <LastUpdated value={baseline.updated_at} />
        </div>
        <fieldset disabled={disabled} className="sending-policy-fieldset">
          <legend className="visually-hidden">Workspace sending policy</legend>
          <div className="sending-field-card">
            <div className="sending-field-heading">
              <div>
                <label htmlFor="sending-hourly-cap">
                  Hourly sending ceiling
                </label>
                <p>
                  Leave blank for no workspace-specific hourly ceiling.
                  Provider, quota, and safety controls still apply. Valid range:
                  1–1,000,000.
                </p>
              </div>
              <InlineHelp text="This is a configured workspace ceiling. Production admission fails closed when the shared cap authority cannot be verified; process-local fallback is limited to explicitly single-process development." />
            </div>
            <div className="sending-input-suffix">
              <input
                id="sending-hourly-cap"
                type="number"
                min={1}
                max={1_000_000}
                step={1}
                inputMode="numeric"
                value={form.rateLimit}
                aria-invalid={fieldErrors.rateLimit ? "true" : undefined}
                aria-describedby={
                  fieldErrors.rateLimit
                    ? "sending-hourly-cap-error"
                    : "sending-hourly-cap-hint"
                }
                onChange={(event) =>
                  setForm({ ...form, rateLimit: event.target.value })
                }
              />
              <span aria-hidden="true">messages/hour</span>
            </div>
            <span id="sending-hourly-cap-hint" className="field-hint">
              The field may stay blank; zero is not a valid configured ceiling.
            </span>
            <FieldError
              id="sending-hourly-cap-error"
              message={fieldErrors.rateLimit}
            />
          </div>

          <div className="sending-field-card">
            <label
              className="sending-toggle-row"
              htmlFor="sending-quiet-enabled"
              aria-label="Quiet hours"
            >
              <span>
                <strong>Quiet hours</strong>
                <small>
                  Hold eligible outbound mail during a recurring local-time
                  window.
                </small>
              </span>
              <input
                id="sending-quiet-enabled"
                className="settings-toggle-input"
                type="checkbox"
                checked={form.quietEnabled}
                onChange={(event) =>
                  setForm({
                    ...form,
                    quietEnabled: event.target.checked,
                    start: event.target.checked ? form.start || "22:00" : "",
                    end: event.target.checked ? form.end || "07:00" : "",
                    timezone: event.target.checked
                      ? form.timezone || "Etc/UTC"
                      : "",
                  })
                }
              />
            </label>
            <div
              className="sending-quiet-grid"
              aria-hidden={!form.quietEnabled || undefined}
            >
              <div className="sending-form-field">
                <label htmlFor="sending-quiet-start">Starts</label>
                <input
                  id="sending-quiet-start"
                  type="time"
                  step={60}
                  value={form.start}
                  disabled={disabled || !form.quietEnabled}
                  aria-invalid={fieldErrors.start ? "true" : undefined}
                  aria-describedby={
                    fieldErrors.start ? "sending-quiet-start-error" : undefined
                  }
                  onChange={(event) =>
                    setForm({ ...form, start: event.target.value })
                  }
                />
                <FieldError
                  id="sending-quiet-start-error"
                  message={fieldErrors.start}
                />
              </div>
              <div className="sending-form-field">
                <label htmlFor="sending-quiet-end">Ends</label>
                <input
                  id="sending-quiet-end"
                  type="time"
                  step={60}
                  value={form.end}
                  disabled={disabled || !form.quietEnabled}
                  aria-invalid={fieldErrors.end ? "true" : undefined}
                  aria-describedby={
                    fieldErrors.end ? "sending-quiet-end-error" : undefined
                  }
                  onChange={(event) =>
                    setForm({ ...form, end: event.target.value })
                  }
                />
                <FieldError
                  id="sending-quiet-end-error"
                  message={fieldErrors.end}
                />
              </div>
              <div className="sending-form-field sending-form-field-wide">
                <label htmlFor="sending-quiet-timezone">
                  Workspace fallback timezone
                </label>
                <select
                  id="sending-quiet-timezone"
                  value={form.timezone}
                  disabled={disabled || !form.quietEnabled}
                  aria-invalid={fieldErrors.timezone ? "true" : undefined}
                  aria-describedby={
                    fieldErrors.timezone
                      ? "sending-quiet-timezone-error"
                      : "sending-quiet-timezone-hint"
                  }
                  onChange={(event) =>
                    setForm({ ...form, timezone: event.target.value })
                  }
                >
                  <option value="">Choose a timezone…</option>
                  {options.map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span id="sending-quiet-timezone-hint" className="field-hint">
                  A previously saved valid IANA timezone remains selectable even
                  if it is outside the curated list.
                </span>
                <FieldError
                  id="sending-quiet-timezone-error"
                  message={fieldErrors.timezone}
                />
              </div>
            </div>
            <label
              className="sending-toggle-row sending-recipient-scope"
              htmlFor="sending-per-recipient"
              aria-label="Evaluate each recipient's timezone"
            >
              <span>
                <strong>Evaluate each recipient’s timezone</strong>
                <small>
                  Use the workspace timezone when recipient timezone data is
                  absent. Malformed values can follow sender-runtime fallback
                  behavior.
                </small>
              </span>
              <input
                id="sending-per-recipient"
                className="settings-toggle-input"
                type="checkbox"
                checked={form.perRecipient}
                disabled={disabled || !form.quietEnabled}
                onChange={(event) =>
                  setForm({ ...form, perRecipient: event.target.checked })
                }
              />
            </label>
          </div>
        </fieldset>
        {baseline.fallback_hour_utc !== null ? (
          <div className="sending-legacy-note" role="note">
            <strong>Legacy fallback preserved.</strong> This route does not edit
            or certify the older fallback-hour projection (
            {baseline.fallback_hour_utc}:00 UTC). Saving or clearing this form
            leaves it unchanged.
          </div>
        ) : null}
        <div className="sending-editor-footer">
          <div>
            <strong>Clear scope</strong>
            <p>
              Clears only the hourly ceiling and quiet hours. Frequency caps,
              identity, IP assignments, and legacy fallback data are preserved.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-danger"
            onClick={controller.openClear}
            disabled={!configured || disabled}
          >
            Clear limit & quiet hours
          </button>
        </div>
      </section>
    </div>
  );
}

function FrequencyPanel({ readOnly }: { readOnly: boolean }): ReactElement {
  return (
    <div className="sending-panel-stack">
      <div className="notice sending-truth-note" role="note">
        <strong>Admission policy, not delivery proof.</strong> Frequency caps
        are checked when campaigns enter the queue. Their counts record queue
        admission and do not certify actual dispatch or delivery.
      </div>
      <FrequencyCapsCard readOnly={readOnly} />
    </div>
  );
}

function IdentityPanel({
  controller,
}: {
  controller: SendingSettingsController;
}): ReactElement {
  const { baseline, settingsResource } = controller;
  const pool = describeIpPool(baseline?.ip_pool);
  const baselineVerified = baseline !== null;
  return (
    <div className="sending-panel-stack">
      <RemoteDataNotice
        resource={settingsResource}
        label="sending identity projection"
        onRetry={() => void settingsResource.reload()}
      />
      <div className="sending-identity-grid">
        <section className="sending-identity-card">
          <span className="sending-eyebrow">Infrastructure projection</span>
          <h2>Reported IP assignment</h2>
          <strong className="sending-identity-value">
            {pool.kind === "known"
              ? pool.name
              : baselineVerified
                ? "Not reported"
                : "Unverified"}
          </strong>
          <p>
            {pool.kind === "known"
              ? `The settings service reports a ${pool.dedicated ? "dedicated" : "shared"} assignment. Actual routing can still fall back based on IP eligibility and provider health.`
              : baselineVerified
                ? "The verified settings response did not include an IP-pool projection. Moosewave will not assume a shared or dedicated lane."
                : "Moosewave has not verified a settings response for this workspace. Retry before relying on routing context."}
          </p>
        </section>
        <section className="sending-identity-card">
          <span className="sending-eyebrow">Domain readiness</span>
          <h2>Authenticate the visible sender</h2>
          <p>
            Custom-domain verification and DNS evidence live on their dedicated
            operational surface.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setSection("domains")}
          >
            Open custom domains
          </button>
        </section>
        <section className="sending-identity-card">
          <span className="sending-eyebrow">Send-time behavior</span>
          <h2>Optimization is configured separately</h2>
          <p>
            Send-time optimization and its canonical fallback hierarchy are not
            controlled by this policy form.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => setSection("sendtime")}
          >
            Open send-time optimization
          </button>
        </section>
      </div>
    </div>
  );
}

function draftChangeSummary(
  baseline: VerifiedSendingSettings | null,
  form: SendingFormState,
): string {
  if (!baseline) return "Unsaved sending-policy changes";
  const projected: VerifiedSendingSettings = {
    ...baseline,
    max_sends_per_hour: form.rateLimit.trim() ? Number(form.rateLimit) : null,
    quiet_hours_start: form.quietEnabled ? form.start : "",
    quiet_hours_end: form.quietEnabled ? form.end : "",
    quiet_hours_tz: form.quietEnabled ? form.timezone : "",
    quiet_hours_per_recipient: form.perRecipient,
  };
  const count = changedSendingFields(baseline, projected).length;
  return `${count || 1} unsaved policy ${count === 1 ? "change" : "changes"}`;
}

export function SendingSettings(): ReactElement {
  const controller = useSendingSettingsController();
  const [activeTab, setActiveTab] = useDesktopRouteTab<SendingSettingsTab>(
    "sending",
    TAB_VALUES,
    "overview",
  );
  const tabs = useTabsInteraction({
    value: activeTab,
    items: TABS,
    onChange: setActiveTab,
    activation: "automatic",
  });

  if (controller.roleStatus !== "resolved" || !controller.canAdmin) {
    return (
      <main className="sending-page">
        <PageHeader
          eyebrow="Delivery"
          title="Sending settings"
          subtitle="Workspace sending policy and operational context."
        />
        <AccessBoundary
          roleStatus={controller.roleStatus}
          accessDenialReason={controller.accessDenialReason}
        />
      </main>
    );
  }

  return (
    <main className="sending-page">
      <PageHeader
        eyebrow="Delivery control"
        title="Sending settings"
        subtitle="Review recipient admission policy alongside revision-checked workspace limits and quiet hours."
        meta={
          <div className="sending-header-meta">
            <span className="sending-admin-chip">Admin only</span>
            {controller.readOnlyDemo ? (
              <span className="sending-demo-chip">Read-only demo</span>
            ) : null}
            <LastUpdated value={controller.baseline?.updated_at ?? null} />
          </div>
        }
        actions={[
          {
            label: controller.refreshing ? "Refreshing…" : "Refresh",
            onClick: () => void controller.refresh(),
            disabled: controller.refreshing,
            title: controller.refreshing
              ? "A verified refresh is already running."
              : "Refresh policy and status evidence.",
          },
        ]}
      />

      <nav
        className="sending-tabs-shell"
        aria-label="Sending settings sections"
      >
        <div
          className="sending-tabs"
          {...tabs.listProps}
          ref={tabs.listRef}
          aria-label="Sending settings sections"
        >
          {TABS.map((tab) => (
            <button
              type="button"
              className={`sending-tab${activeTab === tab.value ? " is-active" : ""}`}
              key={tab.value}
              {...tabs.getTabProps(tab.value)}
            >
              <span>{tab.label}</span>
              <small>{tab.hint}</small>
            </button>
          ))}
        </div>
      </nav>

      <section className="sending-tab-panel" {...tabs.getPanelProps(activeTab)}>
        {activeTab === "overview" ? (
          <OverviewPanel controller={controller} onOpen={setActiveTab} />
        ) : null}
        {activeTab === "limits" ? <LimitsForm controller={controller} /> : null}
        {activeTab === "frequency" ? (
          <FrequencyPanel readOnly={controller.readOnlyDemo} />
        ) : null}
        {activeTab === "identity" ? (
          <IdentityPanel controller={controller} />
        ) : null}
      </section>

      <SaveBar
        dirty={controller.dirty && !controller.readOnlyDemo}
        saving={controller.saving}
        actionsDisabled={controller.mutationUncertain}
        error={controller.mutationError}
        summary={draftChangeSummary(controller.baseline, controller.form)}
        savedAt={controller.savedAt}
        onSave={() => void controller.save()}
        onDiscard={controller.discard}
      />

      <ConfirmModal
        open={controller.clearOpen}
        title="Clear hourly limit and quiet hours?"
        description="This submits a revision-checked settings update. It does not clear frequency caps, sending identity, IP assignments, or legacy fallback data."
        confirmLabel="Clear limit & quiet hours"
        danger
        busy={controller.saving}
        confirmDisabled={controller.mutationUncertain}
        onClose={controller.closeClear}
        onConfirm={controller.confirmClear}
      >
        <div className="sending-clear-review">
          <p>
            The workspace will no longer have this hourly ceiling or be held by
            this quiet-hours window. Provider, quota, and safety controls still
            apply.
          </p>
          {controller.dirty ? (
            <p>
              <strong>
                Your unsaved draft will also be replaced if this clear succeeds.
              </strong>
            </p>
          ) : null}
          {controller.mutationError ? (
            <p className="field-error" role="alert">
              {controller.mutationError}
            </p>
          ) : null}
        </div>
      </ConfirmModal>
    </main>
  );
}
