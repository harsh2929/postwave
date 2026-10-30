// SPDX-License-Identifier: AGPL-3.0-only
import { Badge } from "@/components/ui/badge";
import type { AuditInvestigationStatus } from "@/lib/audit-investigations-api";

const STATUS_VARIANT: Record<
  AuditInvestigationStatus,
  "warning" | "info" | "secondary" | "success"
> = {
  draft: "warning",
  approved: "info",
  rejected: "secondary",
  executed: "success",
};

const STATUS_LABEL: Record<AuditInvestigationStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  rejected: "Rejected",
  executed: "Executed",
};

export function InvestigationStatusBadge({
  status,
}: {
  status: AuditInvestigationStatus;
}) {
  return (
    <Badge variant={STATUS_VARIANT[status]} data-status={status}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export type ConfidenceBucket = "low" | "medium" | "high";

/** Same thresholds as desktop's meter, so one investigation reads alike. */
export function confidenceBucket(confidence: number): ConfidenceBucket {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

export function confidencePercent(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100);
}

/** MITRE technique ids only — anything else is rendered as text, never linked. */
const MITRE_TECHNIQUE_RE = /^T\d{4}(?:\.\d{3})?$/u;

export function mitreTechniqueHref(technique: string): string | null {
  return MITRE_TECHNIQUE_RE.test(technique)
    ? `https://attack.mitre.org/techniques/${technique.replace(".", "/")}/`
    : null;
}
