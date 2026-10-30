/**
 * DryRunPreview — the "we'd import N subscribers, M campaigns…" screen
 * shown between Connect and Run. Reads a MigrationVerificationReport
 * (which the migration service emits when `?dry_run=true` is set) and
 * renders one ResourceBreakdown row per supported resource plus an
 * UnsupportedFeatureBanner.
 *
 * The component is pure: it accepts the report + onConfirm/onCancel
 * callbacks, fetching is done by the parent (the wizard) which already
 * has the SSE/polling glue wired.
 */

import { type ReactElement, useId } from "react";

import { ResourceBreakdown } from "./ResourceBreakdown";
import {
  UnsupportedFeatureBanner,
  type UnsupportedFeature,
} from "./UnsupportedFeatureBanner";
import {
  type MigrationPreview,
  type MigrationResourceCompleteness,
  type MigrationSource,
} from "../../lib/api-client";
import {
  isConsistentMigrationCompletenessState,
  safeMigrationEvidenceText,
} from "./migrations-surface-helpers";

interface Props {
  /** Job id under preview — surfaced in a small subhead. */
  jobId: string;
  /** Canonical source identifier; presentation labels never select behavior. */
  source: MigrationSource;
  /** Source label, e.g. "Mailchimp". */
  sourceLabel: string;
  /** The verification report from the dry-run. */
  preview: MigrationPreview;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  operationError?: string | null;
  commitUnavailableReason?: string;
}

export function DryRunPreview({
  jobId,
  source,
  sourceLabel,
  preview,
  onConfirm,
  onCancel,
  busy,
  operationError,
  commitUnavailableReason,
}: Props): ReactElement {
  const busyReasonId = useId();
  const commitReasonId = useId();
  const isActiveCampaign = source === "activecampaign";
  const isBeehiiv = source === "beehiiv";
  const isKlaviyo = source === "klaviyo";
  const isCustomerIo = source === "customerio";
  const isHubSpot = source === "hubspot";
  const isMailchimp = source === "mailchimp";
  const subscribers = previewCount(preview.subscribers_imported);
  const segments = previewCount(preview.segments_translated);
  const automations = previewCount(preview.automations_translated);
  const completenessRows = Array.isArray(preview.resource_completeness)
    ? preview.resource_completeness
    : [];
  const automationReviewRow =
    isActiveCampaign || isBeehiiv || isKlaviyo || isCustomerIo
      ? completenessRows.find(
          (row) =>
            (row.resource === "automations" ||
              (isCustomerIo && row.resource === "workflow_definitions")) &&
            row.source_total > 0,
        )
      : undefined;
  const automationRebuilds = Math.max(
    previewCount(automationReviewRow?.source_total),
    isCustomerIo ? automations : 0,
  );
  const archive = previewCount(preview.archive_imported);
  const templates = previewCount(preview.templates_imported);
  const sourceArchive = previewCount(preview.source_archive_imported);
  const paidSubs = previewCount(preview.paid_subs_imported);
  const premiumMembershipMetadata =
    completenessRows.find((row) => row.resource === "premium_memberships")
      ?.imported ?? 0;
  const reviewSurfaceRows = cutoverReviewRows(preview);
  const hasCountableResources = migrationPreviewHasCountableResources(
    [
      subscribers,
      segments,
      automations,
      archive,
      templates,
      sourceArchive,
      paidSubs,
      premiumMembershipMetadata,
    ],
    reviewSurfaceRows,
  );

  // This is the number of source subscribers already suppressed or
  // unsubscribed. They are preserved with a non-sendable state; it is not a
  // destination duplicate/skip count.
  const suppressed = previewCount(preview.suppression_list_size);

  const unsupported = unsupportedFeatures(preview, isCustomerIo);
  const commitBlockedReason =
    commitUnavailableReason ??
    migrationDryRunCommitBlockedReason(preview, hasCountableResources, source);

  return (
    <div
      className="dry-run-preview"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div>
        <div style={{ fontSize: 13, color: "var(--pw-fg-muted)" }}>
          Dry-run for {sourceLabel} · exact job <code>{jobId}</code>
        </div>
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 12,
            color: "var(--pw-fg-muted)",
          }}
        >
          No destination resources have been imported. A durable setup job or
          upload may already exist. Review the verified counts, limitations, and
          loss evidence before committing or stepping back.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {subscribers > 0 ? (
          <ResourceBreakdown
            resource="subscribers"
            label="Subscribers"
            planned={subscribers}
            reasons={
              suppressed > 0
                ? [
                    `${suppressed.toLocaleString()} suppressed or unsubscribed at the source (preserved)`,
                  ]
                : undefined
            }
          />
        ) : null}
        {segments > 0 ? (
          <ResourceBreakdown
            resource="segments"
            label={
              isBeehiiv
                ? "Frozen segment/list snapshots"
                : isKlaviyo
                  ? "Enumerated send-targetable list/segment snapshots"
                  : isCustomerIo
                    ? "Frozen segment/topic membership snapshots"
                    : isHubSpot
                      ? "Frozen list/subscription targeting boundaries"
                      : "Segments / tags"
            }
            planned={segments}
            verb={isCustomerIo ? "will be preserved" : "will be created"}
          />
        ) : null}
        {(isActiveCampaign || isBeehiiv || isKlaviyo || isCustomerIo) &&
        automationRebuilds > 0 ? (
          <ResourceBreakdown
            resource="automations"
            label={
              isBeehiiv
                ? "Beehiiv automation rebuild records"
                : isKlaviyo
                  ? "Klaviyo flow rebuild records"
                  : isCustomerIo
                    ? "Customer.io workflow rebuild records"
                    : "Automation rebuilds"
            }
            planned={automationRebuilds}
            verb={
              isBeehiiv || isKlaviyo || isCustomerIo
                ? "must be rebuilt or retired"
                : "need rebuild review"
            }
            reasons={[
              automationReviewRow?.notes?.[0]
                ? safeMigrationEvidenceText(automationReviewRow.notes[0])
                : isBeehiiv
                  ? "Automation metadata is source-preserved, but Beehiiv does not expose executable graphs or message bodies and no runtime automation is activated."
                  : isKlaviyo
                    ? "Klaviyo flow definitions and graph evidence are preserved for manual rebuild; a null definition retains metadata but is not rebuild-complete and requires recovery or retirement. No source flow is activated automatically."
                    : isCustomerIo
                      ? "Customer.io campaign and API-broadcast definitions are preserved as rebuild evidence. No source workflow is activated as a Moosewave runtime automation."
                      : "Source definitions are preserved; no ActiveCampaign automation is activated as a Moosewave runtime automation until rebuilt and tested.",
            ]}
          />
        ) : automations > 0 ? (
          <ResourceBreakdown
            resource="automations"
            label={isMailchimp ? "Classic Automations" : "Sequences"}
            planned={automations}
            verb={isMailchimp ? "will be imported paused" : "will be created"}
            reasons={
              preview.automations_unsupported &&
              preview.automations_unsupported.length > 0
                ? [
                    `${preview.automations_unsupported.length} automation${
                      preview.automations_unsupported.length === 1 ? "" : "s"
                    } ${
                      preview.automations_unsupported.length === 1
                        ? "requires"
                        : "require"
                    } manual rebuild or review and will not be activated`,
                  ]
                : undefined
            }
          />
        ) : null}
        {archive > 0 ? (
          <ResourceBreakdown
            resource="archive"
            label={
              isBeehiiv
                ? "Eligible sent posts"
                : isKlaviyo
                  ? "Sent email campaigns (archive only)"
                  : isCustomerIo
                    ? "Sent email newsletters (archive only)"
                    : "Campaigns (archive)"
            }
            planned={archive}
            verb="will be archived"
          />
        ) : null}
        {isCustomerIo && templates > 0 ? (
          <ResourceBreakdown
            resource="templates"
            label="Editable Design Studio email templates"
            planned={templates}
            verb="will import exact non-empty source HTML with fidelity warnings"
          />
        ) : null}
        {isCustomerIo && sourceArchive > 0 ? (
          <ResourceBreakdown
            resource="source_archive"
            label="Workflow, transactional, channel, preference, object, and ecosystem source evidence"
            planned={sourceArchive}
            verb="will be preserved as read-only evidence"
          />
        ) : null}
        {isBeehiiv && premiumMembershipMetadata > 0 ? (
          <ResourceBreakdown
            resource="premium_memberships"
            label="Premium memberships (metadata only)"
            planned={premiumMembershipMetadata}
            verb="will be preserved on subscribers"
          />
        ) : !isBeehiiv && !isCustomerIo && paidSubs > 0 ? (
          <ResourceBreakdown
            resource="paid_subs"
            label="Paid Stripe subscriptions"
            planned={paidSubs}
            verb="will be linked"
          />
        ) : null}
      </div>

      {!hasCountableResources ? (
        <div className="migration-empty-panel" role="status">
          <strong>No countable resources were reported by this dry-run.</strong>
          <span>
            This is not treated as verified zero. Review the source scope and
            capability evidence before starting a real import.
          </span>
        </div>
      ) : null}

      {isBeehiiv ? (
        <div className="wizard-risk">
          <div className="wizard-risk-title">
            Stripe billing is not part of this import
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Premium memberships remain metadata. No Stripe customers, products,
            prices, subscriptions, renewals, or billing ownership are created;
            verify a separate billing handoff before cutover.
          </p>
        </div>
      ) : null}

      {isKlaviyo ? (
        <div className="wizard-risk">
          <div className="wizard-risk-title">
            Klaviyo runtime parity is not part of this import
          </div>
          <ul>
            <li>
              Stable Klaviyo profile retrieval exposes only the primary email.
              Secondary addresses and independent per-address consent do not
              import; reconcile the multi-email source-archive record during
              both consent and ecosystem review.
            </li>
            <li>
              Unnamed audiences use deterministic Klaviyo list/segment ID
              labels, and predictive profile reads use the stricter 10/second,
              150/minute tier.
            </li>
            <li>
              If a stable profile ID changes email A→B while source-owned A
              remains active, incremental replay stops before writing. The
              full-snapshot delta must materialize B and disable A before replay
              resumes.
            </li>
            <li>
              Reports, SMS identities and consent continuity, and ecommerce do
              not migrate.
            </li>
            <li>
              Sent email campaigns are campaign-archive evidence; SMS/push
              history is non-executable source-archive evidence.
            </li>
            <li>
              Membership counts/tags are the enumerated send-targetable
              projection after validated list-level suppressions, not a
              separately exposed raw count.
            </li>
            <li>
              Draft campaign-message and flow definitions may be null and then
              require provider recovery or retirement. Campaign tags retain
              provider IDs only, not names or groups.
            </li>
            <li>
              Eight unconditional static checklist rows each report one
              checklist record but do not prove product inventory.
            </li>
            <li>
              Cutover requires a frozen final full-snapshot delta with fresh
              verification.
            </li>
          </ul>
        </div>
      ) : null}

      {isCustomerIo ? (
        <div className="wizard-risk">
          <div className="wizard-risk-title">
            Customer.io initial import is not cutover certification
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            This job is bound to one US or EU workspace and traverses
            email-addressable profiles by immutable <code>cio_id</code>.
            Profiles without email and identifiers hidden by GDPR suppression
            require a separate export or retirement decision. Email is enabled
            only when global state is subscribed, the resolved email-channel
            state is subscribed explicitly or by configured default, and the
            applicable topic is subscribed explicitly or by configured default;
            ESP suppressions still block. Sender-specific SMS/WhatsApp
            <code>/v1/optouts</code> are separate non-email evidence, not the
            email-channel preference. Segment and subscription-topic memberships
            are frozen snapshots; provider predicates do not continue
            evaluating. Campaign and API-broadcast workflows are rebuild-only. A
            sent email newsletter enters immutable campaign history only with at
            least one explicit <code>language=&quot;&quot;</code> default and
            provably composable source HTML. The lowest stable content ID
            represents a multi-default/A-B set with an explicit warning; all
            variants remain evidence and translations are never silently
            selected. No/empty layouts use the exact non-empty source body,
            while a non-empty layout must contain exactly one documented{" "}
            <code>{"{{content}}"}</code> slot. Invalid composition remains
            source evidence. Design Studio imports exact non-empty source HTML,
            not provider-rendered output; components, Liquid, styles/assets, and
            transformers require validation. Transactional definitions,
            non-email sends, channel runtime, object dependencies,
            deliverability, and ecosystem obligations remain source evidence.
            Customer.io does not expose a complete profile-change feed for this
            bridge, so cutover requires a final full snapshot, fresh shadow
            verification, rollback rehearsal, and all review gates—not
            source-event replay.
          </p>
        </div>
      ) : null}

      {reviewSurfaceRows.length > 0 ? (
        <div
          className="wizard-risk"
          style={{
            background: "var(--pw-bg-elev)",
            border: "1px solid var(--pw-border)",
            borderRadius: "var(--pw-radius-md)",
            padding: "10px 12px",
          }}
        >
          <div className="wizard-risk-title" style={{ marginBottom: 6 }}>
            Cutover review surfaces
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {reviewSurfaceRows.map((row) => (
              <div key={row.resource} style={{ fontSize: 12 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <strong>
                    {isCustomerIo
                      ? customerIoReviewLabel(row)
                      : safeMigrationEvidenceText(row.label)}
                  </strong>
                  <span className="tabular">
                    {previewCount(row.imported).toLocaleString()}/
                    {previewCount(row.source_total).toLocaleString()}
                  </span>
                </div>
                {row.notes?.[0] ? (
                  <div className="muted" style={{ marginTop: 2 }}>
                    {safeMigrationEvidenceText(row.notes[0])}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <UnsupportedFeatureBanner features={unsupported} />

      {previewPercentage(preview.data_loss_estimate_pct) != null ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--pw-fg-muted)",
            paddingTop: 4,
          }}
        >
          Estimated data-loss vs source:{" "}
          {previewPercentage(preview.data_loss_estimate_pct)!.toFixed(1)}%.{" "}
          {isCustomerIo
            ? "The remaining represented scope follows the documented runtime, archive, rebuild, or source-evidence handling above."
            : "The remaining percentage is migrated 1:1 or with a documented fallback above."}
        </div>
      ) : (
        <div className="migration-truth-callout is-limited">
          <strong>Data-loss estimate was not verified.</strong>
          <span>
            Do not infer zero loss from the absence of a percentage. Review all
            warnings and source limitations before commit.
          </span>
        </div>
      )}

      {operationError ? (
        <div className="field-error" role="alert">
          {operationError}
        </div>
      ) : null}

      {commitBlockedReason ? (
        <div
          id={commitReasonId}
          className="migration-truth-callout is-limited"
          role="alert"
        >
          <strong>Real import is unavailable.</strong>
          <span>{commitBlockedReason}</span>
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 4,
        }}
      >
        <button
          type="button"
          className="btn"
          aria-disabled={busy || undefined}
          aria-describedby={busy ? busyReasonId : undefined}
          onClick={() => {
            if (!busy) onCancel();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={busy || Boolean(commitBlockedReason) || undefined}
          aria-busy={busy || undefined}
          aria-describedby={
            busy
              ? busyReasonId
              : commitBlockedReason
                ? commitReasonId
                : undefined
          }
          onClick={() => {
            if (!busy && !commitBlockedReason) onConfirm();
          }}
        >
          {busy
            ? "Starting…"
            : commitBlockedReason
              ? "Import unavailable"
              : "Looks good — start the real import"}
        </button>
      </div>
      {busy ? (
        <p id={busyReasonId} className="migration-action-reason" role="status">
          The real-import start acknowledgement is pending. The dry-run cannot
          be submitted again or left until that request settles.
        </p>
      ) : null}
    </div>
  );
}

const CUTOVER_REVIEW_RESOURCES = new Set([
  "automations",
  "workflow_definitions",
  "non_email_profiles",
  "subscription_topics",
  "transactional",
  "structured_templates",
  "consent_exclusions",
  "channel_dependencies",
  "templates",
  "forms",
  "landing",
  "landing_pages",
  "ecommerce",
  "reports",
  "crm",
  "custom_objects",
  "deliverability",
  "ecosystem",
  "sms",
  "source_archive",
]);

function cutoverReviewRows(
  report: MigrationPreview,
): MigrationResourceCompleteness[] {
  return (
    Array.isArray(report.resource_completeness)
      ? report.resource_completeness
      : []
  ).filter(
    (row) =>
      previewCount(row.source_total) > 0 &&
      CUTOVER_REVIEW_RESOURCES.has(row.resource) &&
      (previewCount(row.imported) > 0 ||
        row.status === "preserved_for_rebuild" ||
        row.status === "manual_rebuild_required" ||
        row.status === "not_supported"),
  );
}

function unsupportedFeatures(
  preview: MigrationPreview,
  isCustomerIo: boolean,
): UnsupportedFeature[] {
  const unsupported: UnsupportedFeature[] = [];
  for (const [index, warning] of safeArray(
    preview.discovery_warnings,
  ).entries()) {
    unsupported.push({
      id: `discovery:${index}`,
      label: "Discovery warning",
      note: safeMigrationEvidenceText(warning),
    });
  }
  for (const [index, automation] of safeArray(
    preview.automations_unsupported,
  ).entries()) {
    unsupported.push({
      id: `automation:${index}`,
      label: isCustomerIo
        ? `Workflow rebuild: ${safeMigrationEvidenceText(automation.name)}`
        : safeMigrationEvidenceText(automation.name),
      note: safeMigrationEvidenceText(automation.reason),
    });
  }
  if (
    Array.isArray(preview.custom_fields_unmapped) &&
    preview.custom_fields_unmapped.length
  ) {
    unsupported.push({
      id: "custom-fields-unmapped",
      label: `Unmapped custom fields (${preview.custom_fields_unmapped.length})`,
      note: safeMigrationEvidenceText(
        preview.custom_fields_unmapped.slice(0, 6).join(", ") +
          (preview.custom_fields_unmapped.length > 6
            ? `, +${preview.custom_fields_unmapped.length - 6} more`
            : ""),
      ),
    });
  }
  for (const [index, warning] of safeArray(
    preview.segments_with_warnings,
  ).entries()) {
    unsupported.push({
      id: `segment:${index}`,
      label: `${isCustomerIo ? "Segment/topic snapshot" : "Segment"} "${safeMigrationEvidenceText(warning.name)}"`,
      note: safeMigrationEvidenceText(warning.warning),
    });
  }
  for (const [index, warning] of safeArray(
    preview.campaign_archive_warnings,
  ).entries()) {
    unsupported.push({
      id: `campaign:${index}`,
      label: warning.name
        ? `${isCustomerIo ? "Sent newsletter" : "Campaign"} "${safeMigrationEvidenceText(warning.name)}"`
        : isCustomerIo
          ? "Sent email newsletter archive"
          : "Campaign archive",
      note: safeMigrationEvidenceText(warning.warning),
    });
  }
  for (const [index, warning] of safeArray(
    preview.template_warnings,
  ).entries()) {
    unsupported.push({
      id: `template:${index}`,
      label: warning.name
        ? `Template "${safeMigrationEvidenceText(warning.name)}"`
        : "Template",
      note: safeMigrationEvidenceText(warning.warning),
    });
  }
  for (const [index, warning] of safeArray(
    preview.source_archive_warnings,
  ).entries()) {
    unsupported.push({
      id: `source-archive:${index}`,
      label: warning.name
        ? `${isCustomerIo ? "Customer.io source evidence" : "Source archive"} "${safeMigrationEvidenceText(warning.name)}"`
        : isCustomerIo
          ? "Customer.io source evidence"
          : "Source archive",
      note: safeMigrationEvidenceText(warning.warning),
    });
  }
  return unsupported;
}

function customerIoReviewLabel(row: MigrationResourceCompleteness): string {
  switch (row.resource) {
    case "workflow_definitions":
    case "automations":
      return "Customer.io workflow definitions (rebuild only)";
    case "non_email_profiles":
      return "Profiles without email (manual disposition)";
    case "subscription_topics":
      return "Subscription-topic definitions and preferences (review evidence)";
    case "transactional":
      return "Transactional definitions (source evidence)";
    case "structured_templates":
      return "Design Studio definitions (rebuild only)";
    case "consent_exclusions":
      return "ESP suppressions and SMS/WhatsApp sender opt-outs (evidence)";
    case "channel_dependencies":
      return "Non-email channel dependencies (source evidence)";
    case "custom_objects":
      return "Object and relationship dependencies (source evidence)";
    case "deliverability":
      return "Deliverability obligations (source evidence)";
    case "ecosystem":
      return "Ecosystem obligations (source evidence)";
    case "source_archive":
      return "Customer.io source evidence";
    case "templates":
      return "Design Studio template handling";
    default:
      return safeMigrationEvidenceText(row.label);
  }
}

function previewCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function migrationPreviewHasCountableResources(
  counts: number[],
  reviewRows: MigrationResourceCompleteness[],
): boolean {
  return counts.some((count) => count > 0) || reviewRows.length > 0;
}

function previewPercentage(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
}

export function migrationDryRunCommitBlockedReason(
  preview: MigrationPreview,
  hasCountableResources: boolean,
  source?: MigrationSource,
): string | null {
  if (!hasCountableResources) {
    return "The dry-run did not verify any countable source resources. Adjust source scope or credentials and prepare a new dry-run before committing.";
  }
  if (
    !Array.isArray(preview.resource_completeness) ||
    preview.resource_completeness.length === 0
  ) {
    return "The dry-run did not include resource-completeness evidence. Prepare a new dry-run from a compatible server before committing.";
  }
  const resources = new Set<string>();
  const invalidCompletenessRow = preview.resource_completeness.some((row) => {
    const status = row?.status;
    const sourceTotal = row?.source_total;
    const imported = row?.imported;
    const resource = row?.resource?.trim();
    const duplicate = Boolean(resource && resources.has(resource));
    if (resource) resources.add(resource);
    return (
      !row ||
      typeof row !== "object" ||
      !resource ||
      duplicate ||
      typeof row.label !== "string" ||
      row.label.trim().length === 0 ||
      !isConsistentMigrationCompletenessState(
        status,
        row.supported,
        sourceTotal,
        imported,
      )
    );
  });
  if (invalidCompletenessRow) {
    return "The dry-run contained malformed resource-completeness evidence. No import can start from this report; prepare a new dry-run.";
  }
  const countBindings: Array<{
    field: keyof MigrationPreview;
    resources: string[];
  }> = [
    { field: "subscribers_imported", resources: ["subscribers"] },
    { field: "segments_translated", resources: ["segments", "lists"] },
    { field: "paid_subs_imported", resources: ["paid_subs"] },
    { field: "archive_imported", resources: ["archive", "campaigns"] },
    { field: "templates_imported", resources: ["templates"] },
  ];
  if (!source || !REBUILD_ONLY_AUTOMATION_SOURCES.has(source)) {
    countBindings.push({
      field: "automations_translated",
      resources: ["automations"],
    });
  }
  for (const binding of countBindings) {
    const raw = preview[binding.field];
    if (raw === undefined) continue;
    if (!isSafePreviewCount(raw)) {
      return "The dry-run contained malformed top-level resource counts. No import can start from this report; prepare a new dry-run.";
    }
    const matchingRows = preview.resource_completeness.filter((row) =>
      binding.resources.includes(row.resource),
    );
    if (raw > 0 && matchingRows.length === 0) {
      return "The dry-run counts do not reconcile with its resource-completeness evidence. Prepare a new dry-run before committing.";
    }
    if (
      matchingRows.length > 0 &&
      matchingRows.reduce((sum, row) => sum + row.imported, 0) !== raw
    ) {
      return "The dry-run counts do not reconcile with its resource-completeness evidence. Prepare a new dry-run before committing.";
    }
  }
  if (previewPercentage(preview.data_loss_estimate_pct) === null) {
    return "The dry-run did not provide a verified 0–100% data-loss estimate. Prepare a new dry-run before committing; an absent value is never treated as zero loss.";
  }
  return null;
}

const REBUILD_ONLY_AUTOMATION_SOURCES: ReadonlySet<MigrationSource> = new Set([
  "activecampaign",
  "beehiiv",
  "klaviyo",
  "customerio",
  "hubspot",
]);

function isSafePreviewCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}
