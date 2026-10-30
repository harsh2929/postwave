/**
 * VerificationDiff — the post-migration reconciliation report. The
 * "we imported X of Y, nothing lost" diff shown once a competitor
 * migration completes (or when viewing a finished job's report).
 *
 * Given a MigrationVerificationReport it renders:
 *   1. A headline PASS / REVIEW verdict, with the data-loss figure
 *      surfaced *honestly* as an estimate (never as exact / success).
 *   2. A per-resource diff table from resource_completeness[]: source
 *      total vs imported, with a computed per-row verdict badge and a
 *      visible gap on partials. notes[] render under the row.
 *   3. Consent provenance — N of (N+U) preserved, with an honest flag
 *      when some subscribers came across without a recorded opt-in.
 *   4. The "what to check" details: segment warnings, unsupported
 *      automations, and unmapped custom fields.
 *
 * Pure presentation. Defensive throughout: every list is guarded with
 * Array.isArray, every number defaulted with ?? 0 before arithmetic,
 * and no division happens without a positive denominator. When the
 * report is null/empty it says so rather than rendering blank.
 *
 * This is intentionally *honest*: partial / not-supported rows are
 * surfaced truthfully instead of being rounded up to a green tick.
 */

import { Fragment, type ReactElement } from "react";

import {
  type MigrationSource,
  type MigrationResourceCompleteness,
  type MigrationResourceWarning,
  type MigrationVerificationReport,
} from "../../lib/api-client";

interface Props {
  /** The post-import audit. May be null/undefined for older jobs. */
  report?: MigrationVerificationReport | null;
  /** Source controls provider-specific wording for intentional review surfaces. */
  source?: MigrationSource;
}

/* ---------- small formatting helpers ------------------------------ */

function fmtCount(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString();
}

/* ---------- per-row verdict --------------------------------------- */

type RowVerdict = {
  /** "complete" → green, "partial" → amber, "none" → grey. */
  tone: "complete" | "partial" | "none";
  /** Badge text, e.g. "Complete" or "Partial — 8 of 10". */
  label: string;
  /** True when this row needs operator attention (drives the headline). */
  needsReview: boolean;
};

/**
 * Compute the per-row verdict from a completeness row. Numbers are
 * read verbatim from the server; we only derive a label + tone.
 *
 *   imported_runtime / imported          → "Complete" when counts match
 *   partial_runtime / partial            → "Partial — N of M" (the gap)
 *   preserved_for_rebuild                → "Preserved for rebuild"
 *   manual_rebuild_required              → "Manual rebuild required"
 *   not_supported                        → "Not supported"
 *   not_detected                         → "None found"
 */
function rowVerdict(rc: MigrationResourceCompleteness): RowVerdict {
  const sourceTotal = rc.source_total ?? 0;
  const imported = rc.imported ?? 0;

  switch (rc.status) {
    case "imported_runtime":
    case "imported":
      // Zero-of-zero isn't a success to celebrate — the source simply had
      // none of this resource. Call it "None found" so a real 1000-of-1000
      // "Complete" can't be confused with an empty resource class.
      if (sourceTotal === 0 && imported === 0) {
        return { tone: "none", label: "None found", needsReview: false };
      }
      // Honest: only call it complete when we actually carried over at
      // least as many as the source had. A status of "imported" with a
      // shortfall is still a gap and is shown as partial.
      if (imported >= sourceTotal) {
        return { tone: "complete", label: "Complete", needsReview: false };
      }
      return {
        tone: "partial",
        label: `Partial — ${fmtCount(imported)} of ${fmtCount(sourceTotal)}`,
        needsReview: true,
      };
    case "partial_runtime":
    case "partial":
      return {
        tone: "partial",
        label: `Partial — ${fmtCount(imported)} of ${fmtCount(sourceTotal)}`,
        needsReview: true,
      };
    case "preserved_for_rebuild":
      return {
        tone: "partial",
        label: `Preserved for rebuild — ${fmtCount(imported)} of ${fmtCount(
          sourceTotal,
        )}`,
        needsReview: true,
      };
    case "manual_rebuild_required":
      return {
        tone: "partial",
        label: "Manual rebuild required",
        needsReview: true,
      };
    case "not_supported":
      return { tone: "none", label: "Not supported", needsReview: true };
    case "not_detected":
      return { tone: "none", label: "None found", needsReview: false };
    default:
      // Unknown status from the server — surface it verbatim, treat as
      // review-worthy rather than silently passing.
      return {
        tone: "none",
        label: rc.status ? String(rc.status) : "Unknown",
        needsReview: true,
      };
  }
}

function verdictBadgeClass(tone: RowVerdict["tone"]): string {
  switch (tone) {
    case "complete":
      return "badge success";
    case "partial":
      return "badge warning";
    case "none":
    default:
      return "badge";
  }
}

export function verificationAutomationSummary(
  source: MigrationSource | undefined,
  report: Pick<
    MigrationVerificationReport,
    | "automations_translated"
    | "automations_unsupported"
    | "resource_completeness"
  >,
): { label: string; value: number; unsupportedTitle: string } {
  if (
    source === "activecampaign" ||
    source === "beehiiv" ||
    source === "customerio"
  ) {
    return {
      label:
        source === "beehiiv"
          ? "Beehiiv automation rebuild records"
          : source === "customerio"
            ? "Customer.io workflow rebuild records"
            : "Automation rebuilds",
      value:
        report.resource_completeness?.find(
          (row) =>
            row.resource === "automations" ||
            (source === "customerio" &&
              row.resource === "workflow_definitions"),
        )?.source_total ??
        report.automations_unsupported?.length ??
        0,
      unsupportedTitle:
        source === "beehiiv"
          ? "Beehiiv automations to rebuild or retire"
          : source === "customerio"
            ? "Customer.io workflows to rebuild or retire"
            : "Automation rebuilds to review",
    };
  }

  return {
    label: "Automations translated",
    value: report.automations_translated ?? 0,
    unsupportedTitle: "Automations not imported",
  };
}

/* ---------- emptiness check --------------------------------------- */

/**
 * A report is "empty" when it carries no signal at all — no rows, no
 * counts, no warnings. We treat that as "no report available" rather
 * than rendering an all-zero diff that would read as a false PASS.
 */
function isEmptyReport(r: MigrationVerificationReport): boolean {
  const hasRows =
    Array.isArray(r.resource_completeness) &&
    r.resource_completeness.length > 0;
  const hasCounts =
    r.subscribers_imported != null ||
    r.suppression_list_size != null ||
    r.segments_translated != null ||
    r.automations_translated != null ||
    r.paid_subs_imported != null ||
    r.archive_imported != null;
  const hasConsent = r.consent_known != null || r.consent_unknown != null;
  const hasWarnings =
    (Array.isArray(r.discovery_warnings) && r.discovery_warnings.length > 0) ||
    (Array.isArray(r.campaign_archive_warnings) &&
      r.campaign_archive_warnings.length > 0) ||
    (Array.isArray(r.template_warnings) && r.template_warnings.length > 0) ||
    (Array.isArray(r.source_archive_warnings) &&
      r.source_archive_warnings.length > 0) ||
    (Array.isArray(r.segments_with_warnings) &&
      r.segments_with_warnings.length > 0) ||
    (Array.isArray(r.automations_unsupported) &&
      r.automations_unsupported.length > 0) ||
    (Array.isArray(r.custom_fields_unmapped) &&
      r.custom_fields_unmapped.length > 0);
  return !hasRows && !hasCounts && !hasConsent && !hasWarnings;
}

/* ---------- the component ----------------------------------------- */

export function VerificationDiff({ report, source }: Props): ReactElement {
  // Honest empty state — never blank, never fabricated.
  if (!report || isEmptyReport(report)) {
    return (
      <div
        className="card"
        style={{
          padding: "12px 14px",
          border: "1px solid var(--pw-border)",
          borderRadius: 8,
          background: "var(--pw-bg-elev)",
        }}
      >
        <div className="muted" style={{ fontSize: 13 }}>
          No verification report available for this migration.
        </div>
      </div>
    );
  }
  const rows: MigrationResourceCompleteness[] = Array.isArray(
    report.resource_completeness,
  )
    ? report.resource_completeness
    : [];

  // Derive each row's verdict once so the headline and the table agree.
  const verdicts = rows.map((rc) => ({ rc, v: rowVerdict(rc) }));
  const reviewCount = verdicts.filter(({ v }) => v.needsReview).length;
  const allComplete =
    verdicts.length > 0 && verdicts.every(({ v }) => v.tone === "complete");

  // Overall verdict. "Verified" only when every row is complete AND the
  // estimate shows no loss; otherwise "Review recommended". When there
  // are no rows at all we still have counts/warnings to show, so we lean
  // on the data-loss estimate / warning presence for the headline.
  const lossPct = report.data_loss_estimate_pct;
  const hasLoss = typeof lossPct === "number" && lossPct > 0;
  // A partial / not-fully-imported row IS data loss, independent of the
  // optional estimate pct (which the external service may omit). The
  // headline must not claim "no data loss" while the table shows a gap.
  const hasRowGap = verdicts.some(
    ({ v }) => v.tone === "partial" || v.needsReview,
  );
  const verified = allComplete && reviewCount === 0 && !hasLoss;

  // Consent provenance.
  const consentKnown = report.consent_known;
  const consentUnknown = report.consent_unknown;
  const showConsent = consentKnown != null || consentUnknown != null;
  const knownN = consentKnown ?? 0;
  const unknownN = consentUnknown ?? 0;
  const consentTotal = knownN + unknownN;

  // "What to check" detail lists — all defensively guarded.
  const segWarnings = Array.isArray(report.segments_with_warnings)
    ? report.segments_with_warnings
    : [];
  const discoveryWarnings = Array.isArray(report.discovery_warnings)
    ? report.discovery_warnings
    : [];
  const campaignArchiveWarnings = Array.isArray(
    report.campaign_archive_warnings,
  )
    ? report.campaign_archive_warnings
    : [];
  const templateWarnings = Array.isArray(report.template_warnings)
    ? report.template_warnings
    : [];
  const sourceArchiveWarnings = Array.isArray(report.source_archive_warnings)
    ? report.source_archive_warnings
    : [];
  const autoUnsupported = Array.isArray(report.automations_unsupported)
    ? report.automations_unsupported
    : [];
  const automationSummary = verificationAutomationSummary(source, {
    ...report,
    automations_unsupported: autoUnsupported,
  });
  const fieldsUnmapped = Array.isArray(report.custom_fields_unmapped)
    ? report.custom_fields_unmapped
    : [];
  const hasDetails =
    discoveryWarnings.length > 0 ||
    campaignArchiveWarnings.length > 0 ||
    templateWarnings.length > 0 ||
    sourceArchiveWarnings.length > 0 ||
    segWarnings.length > 0 ||
    autoUnsupported.length > 0 ||
    fieldsUnmapped.length > 0;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* ---- Headline verdict --------------------------------------- */}
      <div
        className="card"
        style={{
          padding: "12px 14px",
          border: "1px solid var(--pw-border)",
          borderRadius: 8,
          background: "var(--pw-bg-elev)",
          display: "grid",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={verified ? "badge success" : "badge warning"}>
            {verified ? "Verified" : "Review recommended"}
          </span>
          <strong style={{ fontSize: 14 }}>
            {verified
              ? source === "customerio"
                ? "All represented resources reconcile"
                : "Everything imported"
              : "Some resources need a look"}
          </strong>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {hasLoss
            ? `Estimated data not carried over: ${(lossPct as number).toFixed(
                1,
              )}% — this is an estimate; review the rows below.`
            : hasRowGap
              ? "Some resources weren't fully carried over — review the rows below."
              : "No data loss detected."}
        </div>
        {reviewCount > 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            {reviewCount} resource{reviewCount === 1 ? "" : "s"} partial or not
            supported — see the diff below.
          </div>
        ) : null}
      </div>

      {/* ---- Per-resource diff table -------------------------------- */}
      {verdicts.length > 0 ? (
        <div>
          <div className="section-title" style={{ marginBottom: 6 }}>
            Resource reconciliation
          </div>
          <table className="data-table" style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th>Resource</th>
                <th style={{ width: 90, textAlign: "right" }}>Source</th>
                <th style={{ width: 90, textAlign: "right" }}>
                  {source === "customerio" ? "Represented" : "Imported"}
                </th>
                <th style={{ width: 170 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {verdicts.map(({ rc, v }, i) => {
                const notes = Array.isArray(rc.notes) ? rc.notes : [];
                return (
                  <Fragment key={`${rc.resource ?? "row"}-${i}`}>
                    <tr>
                      <td>
                        {source === "customerio"
                          ? customerIoVerificationResourceLabel(rc)
                          : rc.label || rc.resource || "—"}
                      </td>
                      <td className="tabular" style={{ textAlign: "right" }}>
                        {fmtCount(rc.source_total)}
                      </td>
                      <td className="tabular" style={{ textAlign: "right" }}>
                        {fmtCount(rc.imported)}
                      </td>
                      <td>
                        <span className={verdictBadgeClass(v.tone)}>
                          {v.label}
                        </span>
                      </td>
                    </tr>
                    {notes.length > 0 ? (
                      <tr>
                        <td
                          colSpan={4}
                          className="muted"
                          style={{ fontSize: 11, paddingTop: 0 }}
                        >
                          {notes.map((note, ni) => (
                            <div key={ni}>{note}</div>
                          ))}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* ---- Consent provenance ------------------------------------- */}
      {showConsent ? (
        <div
          style={{
            padding: "10px 12px",
            border: "1px solid var(--pw-border)",
            borderRadius: 8,
            background: "var(--pw-bg-elev)",
            display: "grid",
            gap: 4,
          }}
        >
          <div className="label" style={{ fontSize: 11 }}>
            Consent provenance
          </div>
          <div style={{ fontSize: 12 }}>
            Consent provenance preserved for{" "}
            <strong className="tabular">{fmtCount(knownN)}</strong> of{" "}
            <strong className="tabular">{fmtCount(consentTotal)}</strong>{" "}
            subscriber{consentTotal === 1 ? "" : "s"}.
          </div>
          {unknownN > 0 ? (
            <div
              className="muted"
              style={{ fontSize: 11, color: "var(--pw-warning)" }}
            >
              {fmtCount(unknownN)} subscriber{unknownN === 1 ? "" : "s"} were
              {source === "customerio"
                ? " represented without complete recorded consent provenance — flagged for review, not assumed consented."
                : " imported without a recorded opt-in source — flagged for review, not assumed consented."}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---- What to check: warnings / unsupported / unmapped ------- */}
      {hasDetails ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="section-title">What to check</div>

          {discoveryWarnings.length > 0 ? (
            <div>
              <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>
                Discovery warnings ({discoveryWarnings.length})
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                {discoveryWarnings.map((warning, i) => (
                  <li key={`${warning}-${i}`}>
                    <span className="muted">{warning}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <ResourceWarningsList
            title={
              source === "customerio"
                ? "Sent email newsletter archive warnings"
                : "Campaign archive warnings"
            }
            warnings={campaignArchiveWarnings}
          />
          <ResourceWarningsList
            title="Template warnings"
            warnings={templateWarnings}
          />
          <ResourceWarningsList
            title={
              source === "customerio"
                ? "Customer.io source-evidence warnings"
                : "Source archive warnings"
            }
            warnings={sourceArchiveWarnings}
          />

          {segWarnings.length > 0 ? (
            <div>
              <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>
                Segments with warnings ({segWarnings.length})
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                {segWarnings.map((w, i) => (
                  <li key={`${w.name ?? "seg"}-${i}`}>
                    <strong>{w.name || "Segment"}</strong> —{" "}
                    <span className="muted">{w.warning}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {autoUnsupported.length > 0 ? (
            <div>
              <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>
                {automationSummary.unsupportedTitle} ({autoUnsupported.length})
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                {autoUnsupported.map((a, i) => (
                  <li key={`${a.name ?? "auto"}-${i}`}>
                    <strong>
                      {a.name ||
                        (source === "customerio" ? "Workflow" : "Automation")}
                    </strong>{" "}
                    — <span className="muted">{a.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {fieldsUnmapped.length > 0 ? (
            <div>
              <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>
                Unmapped custom fields ({fieldsUnmapped.length})
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                  fontSize: 11,
                }}
              >
                {fieldsUnmapped.map((f, i) => (
                  <span key={`${f}-${i}`} className="badge">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function customerIoVerificationResourceLabel(
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
      return row.label || row.resource || "—";
  }
}

function ResourceWarningsList({
  title,
  warnings,
}: {
  title: string;
  warnings: MigrationResourceWarning[];
}): ReactElement | null {
  if (warnings.length === 0) return null;
  return (
    <div>
      <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>
        {title} ({warnings.length})
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
        {warnings.map((w, i) => (
          <li key={`${w.resource ?? "resource"}-${w.source_id ?? w.name}-${i}`}>
            <strong>{w.name || w.source_id || w.resource || "Resource"}</strong>{" "}
            <span className="muted">- {w.warning}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
