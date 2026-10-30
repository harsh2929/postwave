// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import {
  activeConsentFilterCount,
  CONSENT_EVIDENCE_FILTERS,
  CONSENT_OUTCOME_FILTERS,
  CONSENT_PERIOD_FILTERS,
  CONSENT_SOURCE_FILTERS,
  type ConsentEvidenceFilter,
  type ConsentEvidenceView,
  type ConsentOutcomeFilter,
  type ConsentPeriodFilter,
  type ConsentSortDirection,
  type ConsentSourceFilter,
} from "./consent-evidence-view";

/**
 * Source chips (with loaded counts), recorded outcome, evidence type,
 * occurrence period, loaded order, and "Reset view" — desktop
 * Consent.tsx:1591-1753. Every control narrows rows already loaded; none of
 * them sends a request.
 */
export function ConsentEvidenceFilters({
  view,
  sourceCounts,
  onChange,
  onReset,
}: {
  view: ConsentEvidenceView;
  sourceCounts: Record<ConsentSourceFilter, number>;
  onChange: (patch: Partial<ConsentEvidenceView>) => void;
  onReset: () => void;
}) {
  const outcomeId = useId();
  const evidenceId = useId();
  const periodId = useId();
  const directionId = useId();
  const active = activeConsentFilterCount(view);

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter by recorded source"
      >
        {CONSENT_SOURCE_FILTERS.map((entry) => {
          const pressed = view.source === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={pressed}
              aria-label={`${entry.label}, ${sourceCounts[entry.id].toLocaleString()} loaded`}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
                pressed
                  ? "border-primary bg-primary/10 font-medium text-foreground"
                  : "bg-background text-muted-foreground hover:border-ring/40 hover:text-foreground",
              )}
              onClick={() => onChange({ source: entry.id })}
            >
              <span>{entry.label}</span>
              <span
                aria-hidden
                className="rounded-full bg-muted px-1.5 text-xs tabular-nums"
              >
                {sourceCounts[entry.id].toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor={outcomeId}>Recorded outcome</Label>
          <Select
            id={outcomeId}
            value={view.outcome}
            onChange={(event) =>
              onChange({
                outcome: event.currentTarget.value as ConsentOutcomeFilter,
              })
            }
          >
            {CONSENT_OUTCOME_FILTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={evidenceId}>Evidence type</Label>
          <Select
            id={evidenceId}
            value={view.evidence}
            onChange={(event) =>
              onChange({
                evidence: event.currentTarget.value as ConsentEvidenceFilter,
              })
            }
          >
            {CONSENT_EVIDENCE_FILTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={periodId}>Occurred</Label>
          <Select
            id={periodId}
            value={view.period}
            onChange={(event) =>
              onChange({
                period: event.currentTarget.value as ConsentPeriodFilter,
              })
            }
          >
            {CONSENT_PERIOD_FILTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={directionId}>Loaded order</Label>
          <Select
            id={directionId}
            value={view.direction}
            onChange={(event) =>
              onChange({
                direction: event.currentTarget.value as ConsentSortDirection,
              })
            }
          >
            <option value="desc">Newest recorded first</option>
            <option value="asc">Oldest loaded first</option>
          </Select>
        </div>
      </div>

      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <span
          className="text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {active === 0
            ? "No filters applied · newest recorded evidence first"
            : `${active.toLocaleString()} ${active === 1 ? "filter" : "filters"} applied`}
        </span>
        {active > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={onReset}>
            Reset view
          </Button>
        ) : null}
      </div>
    </div>
  );
}
