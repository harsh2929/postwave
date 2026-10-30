// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AuditInvestigation } from "@/lib/audit-investigations-api";
import type { RoleKey } from "@/lib/query-keys";

import {
  EvidenceCard,
  EvidenceTimeline,
  useEvidenceRows,
} from "../_components/investigation-evidence";
import { confidencePercent } from "../_components/investigation-status";

/** Cards shown inline per hypothesis; the timeline carries the full set. */
const EVIDENCE_CARDS_PER_FINDING = 8;

/**
 * The evidence viewer: every cited audit row on a timeline, and the numbered
 * hypotheses with the rows each rests on. The page loads it after the
 * investigation itself so the evidence client stays out of the route's first
 * paint.
 */
export function InvestigationEvidenceViewer({
  investigation,
  tenantId,
  roleKey,
}: {
  investigation: AuditInvestigation;
  tenantId: string;
  roleKey: RoleKey;
}) {
  // One batched lookup for every row the page cites anywhere.
  const evidenceIds = useMemo(
    () => [
      ...new Set([
        ...investigation.evidence_audit_ids,
        ...investigation.findings.flatMap((f) => f.evidence_audit_ids),
        ...investigation.proposed_actions.flatMap((a) => a.evidence_audit_ids),
      ]),
    ],
    [investigation],
  );
  const evidence = useEvidenceRows(evidenceIds, tenantId, roleKey);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(16rem,1fr)_2fr]">
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>
            Every cited audit row, oldest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EvidenceTimeline
            seedAuditId={investigation.seed_audit_id}
            evidence={evidence}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hypotheses</CardTitle>
          <CardDescription>
            Each hypothesis cites the audit rows it rests on.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {investigation.findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hypotheses recorded.
            </p>
          ) : (
            investigation.findings.map((finding) => (
              <section
                key={finding.num}
                className="rounded-md border p-4"
                data-testid="investigation-finding"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-medium">
                    #{finding.num} · {finding.hypothesis}
                  </h3>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {confidencePercent(finding.confidence)}%
                  </span>
                </div>
                {finding.mitre_techniques.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {finding.mitre_techniques.map((technique) => (
                      <Badge
                        key={technique}
                        variant="outline"
                        className="font-mono"
                      >
                        {technique}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {finding.detector_reasons?.length ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Detector reasons: {finding.detector_reasons.join(", ")}
                  </p>
                ) : null}
                <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Evidence ({finding.evidence_audit_ids.length})
                </p>
                <div className="mt-2 space-y-2">
                  {finding.evidence_audit_ids
                    .slice(0, EVIDENCE_CARDS_PER_FINDING)
                    .map((auditId) => (
                      <EvidenceCard
                        key={auditId}
                        auditId={auditId}
                        evidence={evidence}
                      />
                    ))}
                </div>
                {finding.evidence_audit_ids.length >
                EVIDENCE_CARDS_PER_FINDING ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    +
                    {finding.evidence_audit_ids.length -
                      EVIDENCE_CARDS_PER_FINDING}{" "}
                    more rows — see the timeline for the full set.
                  </p>
                ) : null}
              </section>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
