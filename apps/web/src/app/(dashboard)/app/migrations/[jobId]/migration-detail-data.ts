// SPDX-License-Identifier: AGPL-3.0-only

import {
  getAuditLog,
  getShadowMonitor,
  getSourceEvents,
  getJob,
  getPilotAcceptance,
  getVerification,
  listAutomationRebuilds,
} from "@/lib/migration-api";
import { ApiError } from "@/lib/api";
import type { SmsPilotReadiness } from "@/lib/sms-api";
import type {
  AutomationRebuildItem,
  AuditEntry,
  MigrationJob,
  PilotAcceptanceReport,
  ShadowMonitorResponse,
  SourceEventMonitorResponse,
  VerificationReport,
} from "@/lib/types";

export type MigrationDetailData = {
  job: MigrationJob;
  report: VerificationReport | null;
  audit: AuditEntry[];
  errors?: Partial<Record<MigrationDetailSidecarKey, string>>;
};

export type MigrationDetailSidecarKey = "report" | "audit";

export type MigrationPilotControlsData = {
  acceptance?: PilotAcceptanceReport;
  rebuilds?: AutomationRebuildItem[];
  shadow?: ShadowMonitorResponse | null;
  sourceEvents?: SourceEventMonitorResponse | null;
  errors?: Partial<Record<MigrationPilotControlKey, string>>;
};

export type MigrationPilotControlKey =
  | "acceptance"
  | "rebuilds"
  | "shadow"
  | "sourceEvents";

export type SMSReadinessCutoverEvidence = {
  ready: boolean;
  detail: string;
  evidence: [string, ...string[]];
};

export function smsReadinessCutoverEvidence(
  readiness: SmsPilotReadiness,
): SMSReadinessCutoverEvidence {
  const blockers = readiness.items
    .filter((item) => item.status === "blocker")
    .map((item) => item.key.trim())
    .filter(Boolean)
    .sort();
  const counts = Object.entries(readiness.counts ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  const evidence: [string, ...string[]] = [
    `sms_pilot_readiness_can_pilot=${readiness.can_pilot}`,
    ...counts,
    ...readiness.items.map((item) => `${item.key}=${item.status}`).sort(),
  ];
  if (!readiness.can_pilot || blockers.length > 0) {
    return {
      ready: false,
      detail:
        blockers.length > 0
          ? `SMS pilot readiness still has blockers: ${blockers.join(", ")}.`
          : "SMS pilot readiness has not authorized a live pilot.",
      evidence,
    };
  }
  return {
    ready: true,
    detail:
      "The current `/api/v1/sms/pilot-readiness` result passed and was recorded after the final ActiveCampaign delta import.",
    evidence,
  };
}

export async function loadMigrationDetailData(
  jobId: string,
): Promise<MigrationDetailData> {
  const [jobResult, reportResult, auditResult] = await Promise.allSettled([
    getJob(jobId),
    getVerification(jobId),
    getAuditLog(jobId),
  ]);
  if (jobResult.status === "rejected") {
    throw jobResult.reason;
  }
  if (
    reportResult.status === "rejected" &&
    jobResult.value.status === "completed" &&
    !isNotFound(reportResult.reason)
  ) {
    throw reportResult.reason;
  }
  const errors: Partial<Record<MigrationDetailSidecarKey, string>> = {};
  if (reportResult.status === "rejected" && !isNotFound(reportResult.reason)) {
    errors.report = errorMessage(reportResult.reason);
  }
  if (auditResult.status === "rejected") {
    errors.audit = errorMessage(auditResult.reason);
  }
  return {
    job: jobResult.value,
    report: reportResult.status === "fulfilled" ? reportResult.value : null,
    audit: auditResult.status === "fulfilled" ? auditResult.value : [],
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}

export async function loadMigrationPilotControls(
  jobId: string,
): Promise<MigrationPilotControlsData> {
  const [acceptance, rebuilds, shadow, sourceEvents] = await Promise.allSettled(
    [
      getPilotAcceptance(jobId),
      listAutomationRebuilds(jobId),
      getShadowMonitor(jobId),
      getSourceEvents(jobId),
    ],
  );
  const errors: Partial<Record<MigrationPilotControlKey, string>> = {};
  const shadowNotStarted =
    shadow.status === "rejected" && isNotFound(shadow.reason);
  const sourceEventsNotStarted =
    sourceEvents.status === "rejected" && isNotFound(sourceEvents.reason);
  if (acceptance.status === "rejected") {
    errors.acceptance = errorMessage(acceptance.reason);
  }
  if (rebuilds.status === "rejected") {
    errors.rebuilds = errorMessage(rebuilds.reason);
  }
  if (shadow.status === "rejected") {
    if (!shadowNotStarted) {
      errors.shadow = errorMessage(shadow.reason);
    }
  }
  if (sourceEvents.status === "rejected") {
    if (!sourceEventsNotStarted) {
      errors.sourceEvents = errorMessage(sourceEvents.reason);
    }
  }
  return {
    ...(acceptance.status === "fulfilled"
      ? { acceptance: acceptance.value }
      : {}),
    ...(rebuilds.status === "fulfilled"
      ? { rebuilds: rebuilds.value.items }
      : {}),
    ...(shadow.status === "fulfilled"
      ? { shadow: shadow.value }
      : shadowNotStarted
        ? { shadow: null }
        : {}),
    ...(sourceEvents.status === "fulfilled"
      ? { sourceEvents: sourceEvents.value }
      : sourceEventsNotStarted
        ? { sourceEvents: null }
        : {}),
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}

function isNotFound(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 404;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Unknown error";
}
