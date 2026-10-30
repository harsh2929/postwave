/** Truthful display summaries shared by migration preview and verification. */

import type {
  MigrationPreview,
  MigrationResourceCompleteness,
} from "../../lib/api-client";

const ACTIVE_CAMPAIGN_AUTOMATION_FALLBACK =
  "Source definitions are preserved; no ActiveCampaign automation is activated as a Moosewave runtime automation until rebuilt and tested.";
const KLAVIYO_FLOW_FALLBACK =
  "Klaviyo flow definitions and graph evidence are preserved for manual rebuild; no source flow is activated automatically.";
const CUSTOMER_IO_WORKFLOW_FALLBACK =
  "Customer.io campaign and API-broadcast workflow definitions are preserved as rebuild evidence; no source workflow is activated as a Moosewave runtime automation.";

/** Rough ETA — Moosewave ingests about 50 subscribers/second on a warm worker. */
export function estimateMigrationImportTime(subscribers: number): string {
  if (subscribers <= 0) return "—";
  const seconds = Math.max(15, Math.round(subscribers / 50));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

function formatCount(value: number | undefined | null): string {
  return (value ?? 0).toLocaleString();
}

function automationCompleteness(
  source: string | undefined,
  report: MigrationPreview | null | undefined,
): MigrationResourceCompleteness | undefined {
  const resources =
    source === "customerio"
      ? new Set(["workflow_definitions", "automations"])
      : new Set(["automations"]);
  return report?.resource_completeness?.find(
    (row) => resources.has(row.resource) && row.source_total > 0,
  );
}

export function migrationWizardAutomationSummary(
  source: string | undefined,
  report: MigrationPreview | null | undefined,
): { label: string; value: string; riskTitle: string; riskNotes: string[] } {
  if (
    source === "activecampaign" ||
    source === "beehiiv" ||
    source === "klaviyo" ||
    source === "customerio"
  ) {
    const row = automationCompleteness(source, report);
    const total = row?.source_total ?? 0;
    const notes = row?.notes?.filter(Boolean) ?? [];
    const isBeehiiv = source === "beehiiv";
    const isKlaviyo = source === "klaviyo";
    const isCustomerIo = source === "customerio";
    return {
      label: isBeehiiv
        ? "Beehiiv automation rebuild records"
        : isKlaviyo
          ? "Klaviyo flow rebuild records"
          : isCustomerIo
            ? "Customer.io workflow rebuild records"
            : "Automation rebuilds",
      value: `${formatCount(total)} ${isBeehiiv || isKlaviyo || isCustomerIo ? "to rebuild or retire" : "to review"}`,
      riskTitle: isBeehiiv
        ? "Beehiiv automations are never activated automatically"
        : isKlaviyo
          ? "Klaviyo flows are never activated automatically"
          : isCustomerIo
            ? "Customer.io workflows are never activated automatically"
            : "Automation rebuilds need review",
      riskNotes:
        total > 0
          ? notes.length > 0
            ? notes
            : [
                isBeehiiv
                  ? "Beehiiv exposes automation metadata, not executable graphs or message bodies. Rebuild or explicitly retire every item before cutover."
                  : isKlaviyo
                    ? KLAVIYO_FLOW_FALLBACK
                    : isCustomerIo
                      ? CUSTOMER_IO_WORKFLOW_FALLBACK
                      : ACTIVE_CAMPAIGN_AUTOMATION_FALLBACK,
              ]
          : [],
    };
  }

  const unsupported = report?.automations_unsupported ?? [];
  if (source === "mailchimp") {
    return {
      label: "Classic Automations",
      value:
        `${formatCount(report?.automations_translated)} imported paused` +
        (unsupported.length > 0
          ? ` (+${unsupported.length} manual review)`
          : ""),
      riskTitle: "Classic Automations requiring manual review",
      riskNotes: unsupported.map((item) =>
        item.name ? `${item.name} - ${item.reason}` : item.reason,
      ),
    };
  }

  return {
    label: "Automations",
    value:
      formatCount(report?.automations_translated) +
      (unsupported.length > 0 ? ` (+${unsupported.length} unsupported)` : ""),
    riskTitle: "Automations that won't port",
    riskNotes: unsupported.map((item) =>
      item.name ? `${item.name} - ${item.reason}` : item.reason,
    ),
  };
}

export function migrationWizardResourceStatusLabel(
  status: string | undefined,
): string {
  switch (status) {
    case "imported_runtime":
    case "imported":
      return "Imported";
    case "partial_runtime":
    case "partial":
      return "Partial";
    case "preserved_for_rebuild":
      return "Preserved for rebuild";
    case "manual_rebuild_required":
      return "Manual rebuild required";
    case "not_supported":
      return "Not supported";
    case "not_detected":
      return "None found";
    default:
      return status?.trim() || "Unknown";
  }
}
