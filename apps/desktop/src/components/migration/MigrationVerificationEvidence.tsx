import { type ReactElement, useMemo } from "react";

import type {
  MigrationJob,
  MigrationResourceCompleteness,
  MigrationVerificationReport,
} from "../../lib/api-client";
import { findSource } from "../../lib/migration-sources";
import {
  formatMigrationCount,
  safeMigrationEvidenceText,
} from "./migrations-surface-helpers";

export function MigrationVerificationEvidence({
  job,
}: {
  job: MigrationJob;
}): ReactElement {
  const report = useMemo(
    () => sanitizeVerificationReport(job.verification_report),
    [job.verification_report],
  );
  const verifiedReport =
    report !== null && verificationReportHasEvidence(report) ? report : null;
  const complete = job.status === "completed";

  return (
    <section
      className="migration-evidence"
      aria-labelledby="migration-evidence-heading"
    >
      <div className="migration-section-heading">
        <div>
          <h3 id="migration-evidence-heading">Verification evidence</h3>
          <p>
            Evidence belongs to job <code>{job.id}</code> from source{" "}
            <code>{job.source}</code>. It does not attest to resources the
            provider did not expose.
          </p>
        </div>
        <span
          className={complete && verifiedReport ? "badge" : "badge warning"}
        >
          {complete
            ? verifiedReport
              ? "Final server report"
              : "Final report unavailable"
            : "Provisional evidence"}
        </span>
      </div>

      {!verifiedReport ? (
        <div className="migration-empty-panel" role="status">
          <strong>No verification report is attached to this job.</strong>
          <span>
            {complete
              ? "Do not infer completeness. Verify destination counts and consent provenance before cutover."
              : "A final report is expected only after the server completes reconciliation."}
          </span>
        </div>
      ) : complete ? (
        <FinalEvidence report={verifiedReport} source={job.source} />
      ) : (
        <ProvisionalEvidence report={verifiedReport} source={job.source} />
      )}

      {verifiedReport ? (
        <CustomFieldMappingEvidence report={verifiedReport} />
      ) : null}

      <SourceLimitations job={job} />
    </section>
  );
}

function verificationReportHasEvidence(
  report: MigrationVerificationReport,
): boolean {
  const numericEvidence = [
    report.subscribers_imported,
    report.suppression_list_size,
    report.segments_translated,
    report.automations_translated,
    report.paid_subs_imported,
    report.premium_memberships_observed,
    report.archive_imported,
    report.templates_imported,
    report.source_archive_imported,
    report.data_loss_estimate_pct,
    report.consent_known,
    report.consent_unknown,
  ].some((value) => typeof value === "number" && Number.isFinite(value));
  const listEvidence = [
    report.resource_completeness,
    report.discovery_warnings,
    report.segments_with_warnings,
    report.automations_unsupported,
    report.custom_fields_mapped,
    report.custom_fields_unmapped,
    report.campaign_archive_warnings,
    report.template_warnings,
    report.source_archive_warnings,
  ].some((value) => Array.isArray(value) && value.length > 0);
  return numericEvidence || listEvidence;
}

function FinalEvidence({
  report,
  source,
}: {
  report: MigrationVerificationReport;
  source: MigrationJob["source"];
}): ReactElement {
  const rows = report.resource_completeness ?? [];
  const warnings = reportReviewNotes(report);
  const rowGaps = rows.filter((row) => !resourceIsComplete(row));
  const loss =
    typeof report.data_loss_estimate_pct === "number" &&
    Number.isFinite(report.data_loss_estimate_pct)
      ? Math.max(0, report.data_loss_estimate_pct)
      : null;
  const unknownConsent = Math.max(0, report.consent_unknown ?? 0);
  const knownConsent = Math.max(0, report.consent_known ?? 0);
  const consentUnverified =
    report.consent_known == null || report.consent_unknown == null;
  const consentTotalMismatch =
    validEvidenceCount(report.subscribers_imported) &&
    knownConsent + unknownConsent !== report.subscribers_imported;
  const reviewSignals =
    rowGaps.length +
    warnings.length +
    (consentUnverified || unknownConsent > 0 || consentTotalMismatch ? 1 : 0) +
    (loss === null || loss > 0 ? 1 : 0) +
    (rows.length === 0 ? 1 : 0);
  const verified = reviewSignals === 0;
  const automationEvidence =
    source === "beehiiv" ||
    source === "activecampaign" ||
    source === "customerio"
      ? (rows.find(
          (row) =>
            row.resource === "automations" ||
            (source === "customerio" &&
              row.resource === "workflow_definitions"),
        )?.source_total ?? report.automations_unsupported?.length)
      : report.automations_translated;
  const membershipEvidence =
    source === "beehiiv"
      ? (report.premium_memberships_observed ??
        rows.find((row) => row.resource === "premium_memberships")?.imported)
      : report.paid_subs_imported;

  return (
    <div className="migration-final-evidence">
      <div
        className={`migration-truth-callout ${verified ? "is-supported" : "is-warning"}`}
        role="status"
      >
        <strong>
          {verified
            ? "Resource counts reconcile with no attached review signals."
            : "Cutover review is required."}
        </strong>
        <span>
          {verified
            ? "The server report reconciles every represented resource. This still covers only data exposed by the source adapter."
            : `${reviewSignals.toLocaleString()} review signal${reviewSignals === 1 ? "" : "s"} remain across resource gaps, consent provenance, loss estimates, or attached notes.`}
        </span>
        {loss !== null ? (
          <span>
            Estimated data not represented: <strong>{loss.toFixed(1)}%</strong>.
            This is an estimate, not an exact loss attestation.
          </span>
        ) : (
          <span>
            No data-loss estimate was attached; absence is not treated as zero.
          </span>
        )}
      </div>

      <dl className="migration-metric-grid">
        <EvidenceMetric
          label="Subscribers imported"
          value={report.subscribers_imported}
        />
        <EvidenceMetric
          label={
            source === "customerio"
              ? "Suppression and preference evidence"
              : "Suppressions imported"
          }
          value={report.suppression_list_size}
        />
        <EvidenceMetric
          label={
            source === "beehiiv"
              ? "Segment/list snapshots"
              : source === "customerio"
                ? "Frozen segment/topic membership snapshots"
                : source === "hubspot"
                  ? "List/subscription targeting boundaries"
                  : "Segments translated"
          }
          value={report.segments_translated}
        />
        <EvidenceMetric
          label={
            source === "beehiiv" || source === "activecampaign"
              ? "Automation rebuild records"
              : source === "customerio"
                ? "Customer.io workflow rebuild records"
                : "Automations translated"
          }
          value={automationEvidence}
        />
        {source !== "customerio" ? (
          <EvidenceMetric
            label={
              source === "beehiiv"
                ? "Premium membership metadata observed"
                : "Paid-subscription records imported"
            }
            value={membershipEvidence}
          />
        ) : null}
        <EvidenceMetric
          label={
            source === "customerio"
              ? "Sent email newsletters archived"
              : "Archive items"
          }
          value={report.archive_imported}
        />
        <EvidenceMetric
          label={
            source === "customerio"
              ? "Editable Design Studio templates"
              : "Templates"
          }
          value={report.templates_imported}
        />
        <EvidenceMetric
          label={
            source === "customerio"
              ? "Workflow, transactional, channel, preference, object, and ecosystem source evidence"
              : "Source archive items"
          }
          value={report.source_archive_imported}
        />
        <EvidenceMetric
          label="Duplicate subscribers merged"
          value={report.duplicate_subscribers_merged}
        />
      </dl>

      {rows.length > 0 ? (
        <ResourceEvidenceTable rows={rows} source={source} />
      ) : (
        <div className="migration-empty-panel" role="status">
          <strong>No per-resource reconciliation rows were attached.</strong>
          <span>Aggregate counts cannot prove per-resource completeness.</span>
        </div>
      )}

      <ConsentEvidence report={report} />

      {warnings.length > 0 ? (
        <details className="migration-evidence-disclosure" open>
          <summary>Required review evidence ({warnings.length})</summary>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ConsentEvidence({
  report,
}: {
  report: MigrationVerificationReport;
}): ReactElement {
  const known = Math.max(0, report.consent_known ?? 0);
  const unknown = Math.max(0, report.consent_unknown ?? 0);
  const total = known + unknown;
  const subscriberTotal = validEvidenceCount(report.subscribers_imported)
    ? report.subscribers_imported
    : null;
  const totalsMatch = subscriberTotal === null || subscriberTotal === total;
  if (report.consent_known == null && report.consent_unknown == null) {
    return (
      <div className="migration-truth-callout is-warning">
        <strong>Consent provenance was not reported.</strong>
        <span>
          Do not infer opt-in status from import success. Verify consent before
          activating sends.
        </span>
      </div>
    );
  }
  return (
    <div
      className={`migration-truth-callout ${unknown > 0 || !totalsMatch ? "is-warning" : "is-supported"}`}
    >
      <strong>Consent provenance</strong>
      <span>
        Recorded provenance was preserved for {formatMigrationCount(known)} of{" "}
        {formatMigrationCount(total)} represented subscribers.
      </span>
      {unknown > 0 ? (
        <span>
          {formatMigrationCount(unknown)} subscriber{unknown === 1 ? "" : "s"}{" "}
          remain without recorded provenance and are flagged for review, not
          assumed consented.
        </span>
      ) : null}
      {!totalsMatch ? (
        <span>
          Consent totals ({formatMigrationCount(total)}) do not reconcile with
          imported subscribers ({formatMigrationCount(subscriberTotal)}).
        </span>
      ) : null}
    </div>
  );
}

function ProvisionalEvidence({
  report,
  source,
}: {
  report: MigrationVerificationReport;
  source: MigrationJob["source"];
}): ReactElement {
  const rows = Array.isArray(report.resource_completeness)
    ? report.resource_completeness
    : [];
  const warnings = reportReviewNotes(report);
  return (
    <div className="migration-provisional-evidence">
      <div className="migration-truth-callout is-warning">
        <strong>Not a final reconciliation.</strong>
        <span>
          Counts can change until the job reaches Completed. Treat this as
          dry-run or partial-run evidence only.
        </span>
      </div>
      <dl className="migration-metric-grid">
        <EvidenceMetric
          label="Subscribers represented"
          value={report.subscribers_imported}
        />
        <EvidenceMetric
          label="Suppressions represented"
          value={report.suppression_list_size}
        />
        <EvidenceMetric
          label="Segments or snapshots represented"
          value={report.segments_translated}
        />
        <EvidenceMetric
          label="Archive items represented"
          value={report.archive_imported}
        />
      </dl>
      {rows.length > 0 ? (
        <ResourceEvidenceTable rows={rows} source={source} />
      ) : null}
      {warnings.length > 0 ? (
        <details className="migration-evidence-disclosure">
          <summary>Review notes ({warnings.length})</summary>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function CustomFieldMappingEvidence({
  report,
}: {
  report: MigrationVerificationReport;
}): ReactElement | null {
  const mapped = report.custom_fields_mapped ?? [];
  const unmapped = report.custom_fields_unmapped ?? [];
  if (mapped.length === 0 && unmapped.length === 0) return null;
  return (
    <details className="migration-evidence-disclosure">
      <summary>
        Custom-field mapping ({mapped.length} mapped · {unmapped.length}{" "}
        unmapped)
      </summary>
      {mapped.length > 0 ? (
        <div
          className="migration-table-region migration-mapping-table-region"
          role="region"
          aria-label="Custom-field mapping evidence"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users must be able to reach and scroll the overflow region
          tabIndex={0}
        >
          <table className="migration-evidence-table">
            <caption className="sr-only">
              Source custom fields mapped to Moosewave fields
            </caption>
            <thead>
              <tr>
                <th scope="col">Source field</th>
                <th scope="col">Moosewave field</th>
                <th scope="col">Type</th>
              </tr>
            </thead>
            <tbody>
              {mapped.map((field, index) => (
                <tr key={`${field.source}-${field.canonical}-${index}`}>
                  <td data-label="Source field">
                    <code>{field.source}</code>
                  </td>
                  <td data-label="Moosewave field">
                    <code>{field.canonical}</code>
                  </td>
                  <td data-label="Type">{field.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {unmapped.length > 0 ? (
        <div className="migration-unmapped-fields">
          <strong>Unmapped source fields</strong>
          <span>
            {unmapped.map((field, index) => (
              <code key={`${field}-${index}`}>{field}</code>
            ))}
          </span>
        </div>
      ) : null}
    </details>
  );
}

function ResourceEvidenceTable({
  rows,
  source,
}: {
  rows: MigrationResourceCompleteness[];
  source: MigrationJob["source"];
}): ReactElement {
  return (
    <div
      className="migration-table-region"
      role="region"
      aria-label="Migration resource reconciliation evidence"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users must be able to reach and scroll the overflow region
      tabIndex={0}
    >
      <table className="migration-evidence-table">
        <caption className="sr-only">
          Source and represented counts by migration resource
        </caption>
        <thead>
          <tr>
            <th scope="col">Resource</th>
            <th scope="col">Handling</th>
            <th scope="col">Source</th>
            <th scope="col">Represented</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.resource}-${index}`}>
              <td data-label="Resource">
                {source === "customerio"
                  ? customerIoResourceEvidenceLabel(row)
                  : safeMigrationEvidenceText(row.label || row.resource)}
                <code>{safeMigrationEvidenceText(row.resource)}</code>
              </td>
              <td data-label="Handling">
                <CompletenessBadge row={row} source={source} />
              </td>
              <td data-label="Source" className="tabular">
                {formatMigrationCount(row.source_total)}
              </td>
              <td data-label="Represented" className="tabular">
                {formatMigrationCount(row.imported)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvidenceMetric({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{formatMigrationCount(value)}</dd>
    </div>
  );
}

function SourceLimitations({ job }: { job: MigrationJob }): ReactElement {
  const sourceName = findSource(job.source)?.name ?? "This source";
  let supported: string;
  let limited: string;
  if (job.source === "beehiiv") {
    supported =
      "Subscriber, suppression, sent-post/archive, and source-exposed historical evidence can be represented when confirmed by the report.";
    limited =
      "Dynamic segment rules and automations remain rebuild evidence. Premium memberships remain subscriber/source metadata; Stripe customers, subscriptions, renewals, ownership, and billing are not migrated.";
  } else if (job.source === "activecampaign") {
    supported =
      "Source-exposed subscribers, consent, tags, lists, fields, and campaign evidence are represented only when confirmed by the report.";
    limited =
      "Automation definitions are review and rebuild evidence, not activated Moosewave workflows. Rebuild and test them before cutover.";
  } else if (job.source === "customerio") {
    supported =
      "Email-addressable profiles retain immutable cio_id ownership, authoritative final-snapshot email and fields, frozen segment/topic membership, exact-source Design Studio templates, and eligible sent email newsletter history only when confirmed by this exact workspace-bound report.";
    limited =
      'Newsletter history requires at least one explicit language="" default and provable source composition; the lowest stable content ID represents a multi-default/A-B set with an explicit warning, all variants remain evidence, translations are never silently selected, and invalid layout/body composition remains source evidence. Newsletter and Design Studio HTML are exact source content/composition, not provider-rendered output; Liquid, CSS/assets/components/styles/transformers, and per-recipient rendering require validation. Profiles without email and GDPR-hidden identifiers require separate disposition. Dynamic predicates and campaign/API-broadcast workflows must be rebuilt or retired; transactional, non-email, channel, object, deliverability, and ecosystem records remain read-only source evidence. A final full snapshot and six review gates are required because source-event replay is unavailable.';
  } else {
    supported = `${sourceName} resources are migrated only when the adapter and this job's report mark them imported.`;
    limited =
      "Provider-retained data, dynamic rules, unsupported automations, external billing, and fields omitted by the source API are not silently inferred or recreated.";
  }
  return (
    <div className="migration-source-limitations">
      <div className="migration-truth-callout is-supported">
        <strong>Source-supported</strong>
        <span>{supported}</span>
      </div>
      <div className="migration-truth-callout is-limited">
        <strong>Rebuild, metadata, or provider limitation</strong>
        <span>{limited}</span>
      </div>
    </div>
  );
}

function CompletenessBadge({
  row,
  source,
}: {
  row: MigrationResourceCompleteness;
  source: MigrationJob["source"];
}): ReactElement {
  if (
    (row.status === "imported" || row.status === "imported_runtime") &&
    (!validEvidenceCount(row.imported) ||
      !validEvidenceCount(row.source_total) ||
      row.imported !== row.source_total)
  ) {
    return <span className="badge warning">Count mismatch</span>;
  }
  if (
    (row.status === "imported" || row.status === "imported_runtime") &&
    row.imported === 0 &&
    row.source_total === 0
  ) {
    return <span className="badge">None found</span>;
  }
  switch (row.status) {
    case "imported_runtime":
    case "imported":
      return (
        <span className="badge success">
          {source === "customerio" && row.resource === "source_archive"
            ? "Source evidence preserved"
            : source === "customerio" && row.resource === "campaigns"
              ? "Newsletter archive preserved"
              : "Imported"}
        </span>
      );
    case "partial_runtime":
    case "partial":
      return <span className="badge warning">Partial</span>;
    case "preserved_for_rebuild":
      return (
        <span className="badge warning">
          {source === "customerio" && row.resource === "source_archive"
            ? "Source evidence preserved"
            : "Rebuild evidence"}
        </span>
      );
    case "manual_rebuild_required":
      return <span className="badge warning">Manual rebuild</span>;
    case "not_supported":
      return <span className="badge">Not supported</span>;
    case "not_detected":
      return <span className="badge">Not detected</span>;
    default:
      return <span className="badge">Review</span>;
  }
}

function customerIoResourceEvidenceLabel(
  row: MigrationResourceCompleteness,
): string {
  switch (row.resource) {
    case "segments":
      return "Frozen segment/topic membership snapshots";
    case "non_email_profiles":
      return "Profiles without email (manual disposition)";
    case "subscription_topics":
      return "Subscription-topic definitions and preferences (review evidence)";
    case "workflow_definitions":
    case "automations":
      return "Customer.io workflow definitions (rebuild only)";
    case "campaigns":
      return "Sent email newsletter archive";
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
      return "Exact Customer.io source evidence";
    default:
      return safeMigrationEvidenceText(row.label || row.resource);
  }
}

function resourceIsComplete(row: MigrationResourceCompleteness): boolean {
  if (
    !validEvidenceCount(row.imported) ||
    !validEvidenceCount(row.source_total)
  ) {
    return false;
  }
  if (row.status === "not_detected") {
    return row.imported === 0 && row.source_total === 0;
  }
  if (row.status !== "imported" && row.status !== "imported_runtime") {
    return false;
  }
  return row.imported === row.source_total;
}

function validEvidenceCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function reportReviewNotes(report: MigrationVerificationReport): string[] {
  const notes = [
    ...(report.resource_completeness ?? []).flatMap((row) =>
      (row.notes ?? []).map((note) => `${row.label || row.resource}: ${note}`),
    ),
    ...(report.discovery_warnings ?? []),
    ...(report.segments_with_warnings ?? []).map(
      (item) => `${item.name}: ${item.warning}`,
    ),
    ...(report.automations_unsupported ?? []).map(
      (item) => `${item.name}: ${item.reason}`,
    ),
    ...(report.custom_fields_unmapped ?? []).map(
      (field) => `Unmapped custom field: ${field}`,
    ),
    ...(report.campaign_archive_warnings ?? []).map(
      (item) =>
        `${item.name ?? item.source_id ?? item.resource}: ${item.warning}`,
    ),
    ...(report.template_warnings ?? []).map(
      (item) =>
        `${item.name ?? item.source_id ?? item.resource}: ${item.warning}`,
    ),
    ...(report.source_archive_warnings ?? []).map(
      (item) =>
        `${item.name ?? item.source_id ?? item.resource}: ${item.warning}`,
    ),
  ];
  const mergeConflicts = report.subscriber_merge_conflicts?.length ?? 0;
  if (mergeConflicts > 0) {
    notes.push(
      `${mergeConflicts.toLocaleString()} subscriber merge conflict${mergeConflicts === 1 ? "" : "s"} require review; profile details are withheld from this summary.`,
    );
  }
  return notes;
}

function sanitizeVerificationReport(
  report: MigrationVerificationReport | null | undefined,
): MigrationVerificationReport | null {
  if (!report || typeof report !== "object") return null;
  const safe = safeMigrationEvidenceText;
  return {
    ...report,
    discovery_warnings: Array.isArray(report.discovery_warnings)
      ? report.discovery_warnings.map(safe)
      : [],
    custom_fields_unmapped: Array.isArray(report.custom_fields_unmapped)
      ? report.custom_fields_unmapped.map(safe)
      : [],
    custom_fields_mapped: Array.isArray(report.custom_fields_mapped)
      ? report.custom_fields_mapped.map((field) => ({
          ...field,
          source: safe(field.source),
          canonical: safe(field.canonical),
          type: safe(field.type),
        }))
      : [],
    segments_with_warnings: Array.isArray(report.segments_with_warnings)
      ? report.segments_with_warnings.map((warning) => ({
          name: safe(warning.name),
          warning: safe(warning.warning),
        }))
      : [],
    automations_unsupported: Array.isArray(report.automations_unsupported)
      ? report.automations_unsupported.map((automation) => ({
          name: safe(automation.name),
          reason: safe(automation.reason),
        }))
      : [],
    resource_completeness: Array.isArray(report.resource_completeness)
      ? report.resource_completeness.map((row) => ({
          ...row,
          resource: safe(row.resource),
          label: safe(row.label),
          notes: Array.isArray(row.notes) ? row.notes.map(safe) : [],
        }))
      : [],
    campaign_archive_warnings: sanitizeResourceWarnings(
      report.campaign_archive_warnings,
    ),
    template_warnings: sanitizeResourceWarnings(report.template_warnings),
    source_archive_warnings: sanitizeResourceWarnings(
      report.source_archive_warnings,
    ),
  };
}

function sanitizeResourceWarnings(
  warnings: MigrationVerificationReport["campaign_archive_warnings"],
): NonNullable<MigrationVerificationReport["campaign_archive_warnings"]> {
  if (!Array.isArray(warnings)) return [];
  return warnings.map((warning) => ({
    ...warning,
    resource: safeMigrationEvidenceText(warning.resource),
    source_id: warning.source_id
      ? safeMigrationEvidenceText(warning.source_id)
      : undefined,
    name: warning.name ? safeMigrationEvidenceText(warning.name) : undefined,
    warning: safeMigrationEvidenceText(warning.warning),
  }));
}
