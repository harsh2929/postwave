// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import { BookOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PrivacyIncident } from "@/lib/privacy-incidents-api";
import { cn } from "@/lib/utils";

export interface PrivacyIncidentStats {
  loadedCount: number;
  openCount: number;
  priorityCount: number;
  operationalTargetPassedCount: number;
  completeScopeCount: number;
}

function scopeComplete(incident: PrivacyIncident): boolean {
  return (
    incident.affected_regions.length > 0 &&
    incident.affected_data_categories.length > 0 &&
    incident.affected_subject_count !== undefined &&
    incident.affected_subject_count !== null &&
    incident.jurisdictions.length > 0
  );
}

function targetPassed(incident: PrivacyIncident, now: number): boolean {
  if (incident.status === "closed" || !incident.gdpr_72h_deadline) return false;
  const target = Date.parse(incident.gdpr_72h_deadline);
  return Number.isFinite(target) && target < now;
}

/**
 * Counts over LOADED rows only (desktop summarizePrivacyIncidents,
 * PrivacyIncidents.tsx:481-515). "Needs attention" is a non-terminal row whose
 * stored operational target has passed or whose severity is high/critical.
 */
export function summarizePrivacyIncidents(
  rows: readonly PrivacyIncident[],
  now: number,
): PrivacyIncidentStats {
  let openCount = 0;
  let priorityCount = 0;
  let operationalTargetPassedCount = 0;
  let completeScopeCount = 0;
  for (const incident of rows) {
    const passed = targetPassed(incident, now);
    if (passed) operationalTargetPassedCount += 1;
    if (incident.status !== "closed") {
      openCount += 1;
      if (
        passed ||
        incident.severity === "critical" ||
        incident.severity === "high"
      ) {
        priorityCount += 1;
      }
    }
    if (scopeComplete(incident)) completeScopeCount += 1;
  }
  return {
    loadedCount: rows.length,
    openCount,
    priorityCount,
    operationalTargetPassedCount,
    completeScopeCount,
  };
}

const WORKFLOW_STAGES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Open",
    body: "Create a preliminary incident record when a possible breach is detected. Stored timestamps and targets support triage but do not determine jurisdiction or legal obligations.",
  },
  {
    title: "Contained",
    body: "Record an operator-reported containment state and reason. This is workflow context, not independently verified containment evidence.",
  },
  {
    title: "Notifications pending",
    body: "Record that the workflow is awaiting notifications. Packet generation, approval, download, and manual delivery claims are release-held.",
  },
  {
    title: "Closed (release-held)",
    body: "Closure is unavailable until independent counsel identity, notification decisions, delivery receipts, and an atomic state transition are enforced and verified end to end.",
  },
];

/**
 * The privacy-incident register's stat strip, with a hint under every number
 * that scopes it to loaded rows and disclaims legal determination, plus the
 * "Learn the workflow" explainer (desktop PrivacyIncidents.tsx:1076-1105,
 * 2106-2141). Client-only: it reads the rows the page already verified.
 */
export function PrivacyIncidentStatStrip({
  rows,
  now,
}: {
  rows: readonly PrivacyIncident[];
  now: number;
}) {
  const [learning, setLearning] = useState(false);
  const stats = useMemo(() => summarizePrivacyIncidents(rows, now), [rows, now]);
  const cells: ReadonlyArray<{
    label: string;
    value: string;
    hint: string;
    danger?: boolean;
  }> = [
    {
      label: "Needs attention",
      value: stats.priorityCount.toLocaleString(),
      hint: "Loaded non-terminal rows whose stored operational target has passed or whose recorded severity is high or critical. This is a triage signal, not a legal determination.",
      danger: stats.priorityCount > 0,
    },
    {
      label: "Operational target passed",
      value: stats.operationalTargetPassedCount.toLocaleString(),
      hint: "Loaded non-terminal rows whose stored system target is earlier than now. The target is not represented as a legal deadline.",
    },
    {
      label: "Loaded non-terminal",
      value: stats.openCount.toLocaleString(),
      hint: "Loaded rows in open, contained, or notifying state. State is an operator record, not independent containment or delivery proof.",
    },
    {
      label: "Scope fields complete",
      value: `${stats.completeScopeCount.toLocaleString()} / ${stats.loadedCount.toLocaleString()}`,
      hint: "Loaded rows with stored regions, data categories, subject estimate, and jurisdictions. Four present fields do not establish correct or complete legal scope.",
    },
  ];

  return (
    <section aria-label="Loaded incident evidence summary" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Every count covers only the {stats.loadedCount.toLocaleString()}{" "}
          {stats.loadedCount === 1 ? "row" : "rows"} loaded in this browser.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setLearning(true)}
        >
          <BookOpen aria-hidden />
          Learn the workflow
        </Button>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cells.map((cell) => (
          <div key={cell.label} className="rounded-xl border bg-card p-4">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {cell.label}
            </dt>
            <dd
              className={cn(
                "mt-1 text-2xl font-semibold tabular-nums",
                cell.danger && "text-destructive-emphasis",
              )}
            >
              {cell.value}
            </dd>
            <dd className="mt-1 text-xs leading-5 text-muted-foreground">
              {cell.hint}
            </dd>
          </div>
        ))}
      </dl>

      <Dialog open={learning} onOpenChange={setLearning}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>The breach-response workflow</DialogTitle>
            <DialogDescription>
              What this release records—and what still requires an approved
              external legal process.
            </DialogDescription>
          </DialogHeader>
          <ol className="space-y-3">
            {WORKFLOW_STAGES.map((stage) => (
              <li key={stage.title} className="rounded-xl border p-3">
                <p className="text-sm font-semibold">{stage.title}</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {stage.body}
                </p>
              </li>
            ))}
          </ol>
          <DialogFooter>
            <Button type="button" onClick={() => setLearning(false)}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
