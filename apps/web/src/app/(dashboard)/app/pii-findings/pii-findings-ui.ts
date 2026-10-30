// SPDX-License-Identifier: AGPL-3.0-only

import { ApiError } from "@/lib/api";
import type {
  PiiFindingStatus,
  PiiReviewReason,
  PiiScanConfig,
  PiiTerminalStatus,
} from "@/lib/pii-findings-api";

export const REVIEW_REASON_OPTIONS = [
  {
    value: "confirmed_pii",
    label: "Confirmed personal data",
    description: "The detector is correct and the field needs governance.",
  },
  {
    value: "remediated",
    label: "Remediated",
    description: "The exposure was corrected and evidence is attached.",
  },
  {
    value: "accepted_risk",
    label: "Accepted risk",
    description: "An authorized owner accepted the documented residual risk.",
  },
] as const satisfies ReadonlyArray<{
  value: PiiReviewReason;
  label: string;
  description: string;
}>;

export const DISMISS_REASON_OPTIONS = [
  {
    value: "false_positive",
    label: "False positive",
    description: "The pattern is not personal data.",
  },
  {
    value: "duplicate",
    label: "Duplicate finding",
    description: "The same exposure is tracked by another finding.",
  },
  {
    value: "test_data",
    label: "Test data",
    description: "The value is verified non-production fixture data.",
  },
  {
    value: "not_personal_data",
    label: "Not personal data",
    description: "The value does not identify or relate to a natural person.",
  },
] as const satisfies ReadonlyArray<{
  value: PiiReviewReason;
  label: string;
  description: string;
}>;

export function reasonOptions(status: PiiTerminalStatus) {
  return status === "reviewed"
    ? REVIEW_REASON_OPTIONS
    : DISMISS_REASON_OPTIONS;
}

export function reviewReasonLabel(reason: string): string {
  if (reason === "legacy_migrated") {
    return "Legacy decision — original rationale unavailable";
  }
  return (
    [...REVIEW_REASON_OPTIONS, ...DISMISS_REASON_OPTIONS].find(
      (option) => option.value === reason,
    )?.label ?? reason.replaceAll("_", " ")
  );
}

export function statusBadgeVariant(
  status: PiiFindingStatus,
): "warning" | "success" | "outline" {
  if (status === "pending") return "warning";
  if (status === "reviewed") return "success";
  return "outline";
}

export interface PiiSurfaceError {
  title: string;
  message: string;
  kind: "admin" | "conflict" | "unavailable" | "transient" | "invalid";
}

export function describePiiError(error: unknown): PiiSurfaceError {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        kind: "admin",
        title: "Admin access required",
        message:
          "Shadow-PII evidence is restricted to workspace owners and administrators.",
      };
    }
    if (error.status === 409) {
      return {
        kind: "conflict",
        title: "Finding changed before this decision",
        message:
          "Another reviewer recorded a decision or the finding version changed. Refresh before acting; the first immutable receipt was preserved.",
      };
    }
    if (error.status === 404 || error.status === 501) {
      return {
        kind: "unavailable",
        title: "Scanner capability unavailable",
        message:
          "This deployment does not expose the Shadow-PII review service. No clean state has been inferred.",
      };
    }
    if (
      error.kind === "network" ||
      error.kind === "offline" ||
      error.kind === "timeout" ||
      error.status >= 500
    ) {
      return {
        kind: "transient",
        title: "Scanner service unavailable",
        message:
          "The queue could not be verified. Retry when the service is healthy; no empty state has been inferred.",
      };
    }
    return {
      kind: "invalid",
      title: "Could not verify scanner state",
      message:
        "The service rejected this privacy request or returned an invalid contract. Refresh verified data before trying again.",
    };
  }
  return {
    kind: "transient",
    title: "Could not verify scanner state",
    message: "Retry the request before making a privacy decision.",
  };
}

export function scanStatusLabel(status: PiiScanConfig["status"]): string {
  return (
    {
      enabled_backfilling: "Enabled · reconciling",
      enabled_caught_up: "Enabled · current snapshot covered",
      enabled_degraded: "Enabled · known gaps",
      disabled: "Disabled",
      unavailable: "Unavailable",
    } satisfies Record<PiiScanConfig["status"], string>
  )[status];
}

export function coverageLimitationLabel(value: string): string {
  return (
    {
      scanner_dependency_unavailable: "Scanner dependencies are unavailable.",
      scanning_disabled: "Scanning is disabled for this workspace.",
      current_profile_snapshot_only_intermediate_revisions_may_be_coalesced:
        "Coverage is limited to the current subscriber-row projection; intermediate revisions may be coalesced.",
      retained_attribute_history_notes_and_event_content_not_scanned:
        "Retained attribute history, notes, attachments, and event/content payloads are outside this scanner.",
      bounded_detector_truncation_requires_operator_repair:
        "Bounded detector truncation remains a visible gap until repaired.",
      coverage_snapshot_reconciliation_pending:
        "The exact current-profile reconciliation is still pending.",
      dead_letters_require_operator_requeue:
        "Exhausted work remains visible in the dead-letter queue until an operator requeues it.",
    } as Record<string, string>
  )[value] ?? value.replaceAll("_", " ");
}
