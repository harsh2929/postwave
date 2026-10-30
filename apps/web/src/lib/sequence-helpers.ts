// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure, dependency-free helpers for the sequences cluster. Kept out of the
// React components (and the network-touching voice-api) so list filtering,
// duplicate step preservation, delay math, markdown export, and profile
// staleness are synchronously unit-testable.

import type {
  Sequence,
  SequenceListItem,
  SequenceStatus,
  SequenceStoredStep,
  SequenceTemplate,
  VoiceSource,
} from "./voice-types";

// ----- List filtering & sorting (SEQ-007) --------------------------------

export type SequenceStatusGroup = "draft" | "archived" | "read-only";
export type SequenceStatusFilter = "all" | SequenceStatusGroup;
export type SequenceSortKey = "name" | "fidelity" | "updated";
export type SortDir = "asc" | "desc";

/** Collapse the raw lifecycle status into the three groups the hub shows. */
export function sequenceStatusGroup(status: SequenceStatus): SequenceStatusGroup {
  if (status === "draft") return "draft";
  if (status === "archived") return "archived";
  return "read-only";
}

export interface SequenceListQuery {
  query: string;
  statusFilter: SequenceStatusFilter;
  sort: SequenceSortKey;
  dir: SortDir;
}

/**
 * Filter (by name/template substring + status group) and sort a sequence list.
 * Sorting is stable-ish: ties fall back to case-insensitive name so equal
 * fidelity/date rows keep a deterministic order.
 */
export function filterSortSequences(
  rows: readonly SequenceListItem[],
  { query, statusFilter, sort, dir }: SequenceListQuery,
): SequenceListItem[] {
  const q = query.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (
      statusFilter !== "all" &&
      sequenceStatusGroup(row.status) !== statusFilter
    ) {
      return false;
    }
    if (!q) return true;
    return (
      row.name.toLowerCase().includes(q) ||
      row.templateName.toLowerCase().includes(q)
    );
  });

  const factor = dir === "asc" ? 1 : -1;
  return filtered.sort((a, b) => {
    let primary = 0;
    if (sort === "name") {
      primary = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    } else if (sort === "fidelity") {
      primary = a.fidelityAvg - b.fidelityAvg;
    } else {
      primary =
        new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    }
    if (primary !== 0) return primary * factor;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

// ----- Template-name resolution (SEQ-038) --------------------------------

/**
 * Build a lookup from a template's id AND slug to its human name, so a stored
 * `template_id` (which may be either) can be resolved to a friendly label.
 */
export function templateNameLookup(
  templates: readonly SequenceTemplate[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const template of templates) {
    if (template.id) map.set(template.id, template.name);
    if (template.slug) map.set(template.slug, template.name);
  }
  return map;
}

/** Resolve a raw template id/slug to a friendly name, falling back to the raw. */
export function resolveTemplateName(
  rawTemplateId: string,
  lookup: Map<string, string>,
): string {
  if (!rawTemplateId) return "—";
  return lookup.get(rawTemplateId) ?? rawTemplateId;
}

// ----- Duplicate step preservation (SEQ-005) -----------------------------

/**
 * Produce the full stored-step list for a duplicate, preserving EVERY step
 * type (delay/condition/tag/exit) when the source carries a step graph, and
 * only falling back to email-only reconstruction for legacy step-less rows.
 * Positions are renumbered 1..n so the copy is well-formed. Returns the
 * COMPLETE list (never a partial) to respect the PATCH-replace contract.
 */
export function stepsForDuplicate(src: Sequence): SequenceStoredStep[] {
  if (src.steps && src.steps.length > 0) {
    return src.steps.map((step, index) => ({
      ...step,
      position: index + 1,
    }));
  }
  return src.emails.map((email, index) => ({
    type: "email" as const,
    position: index + 1,
    email: {
      subject: email.subject,
      body: email.bodyMarkdown,
      body_html: email.bodyHtml || undefined,
      body_mjml: email.bodyMjml ?? undefined,
      delay_seconds: Math.max(0, Math.round(email.delayHours * 3600)),
    },
  }));
}

// ----- Delay value+unit math (SEQ-027) -----------------------------------

export type DelayUnit = "minutes" | "hours" | "days";

const UNIT_SECONDS: Record<DelayUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

/**
 * Convert a raw hours value into the largest clean value+unit pair (so 72h
 * shows as "3 days", 0.5h as "30 minutes"), matching the builder's control.
 */
export function hoursToDelay(hours: number): { value: number; unit: DelayUnit } {
  const seconds = Math.max(0, Math.round((Number(hours) || 0) * 3600));
  if (seconds === 0) return { value: 0, unit: "hours" };
  if (seconds % UNIT_SECONDS.days === 0) {
    return { value: seconds / UNIT_SECONDS.days, unit: "days" };
  }
  if (seconds % UNIT_SECONDS.hours === 0) {
    return { value: seconds / UNIT_SECONDS.hours, unit: "hours" };
  }
  return { value: Math.round(seconds / UNIT_SECONDS.minutes), unit: "minutes" };
}

/** Convert a value+unit pair back to hours (the model the API stores). */
export function delayToHours(value: number, unit: DelayUnit): number {
  const secs = Math.max(0, (Number(value) || 0) * UNIT_SECONDS[unit]);
  return secs / 3600;
}

/** Human phrase for a delay in hours, e.g. "Send immediately", "3 days". */
export function describeDelay(hours: number): string {
  if (!hours || hours <= 0) return "Send immediately";
  const { value, unit } = hoursToDelay(hours);
  const singular = unit.slice(0, -1);
  return `${value} ${value === 1 ? singular : unit}`;
}

// ----- Markdown export (SEQ-066) -----------------------------------------

/** Serialize a full sequence to a portable markdown document. */
export function sequenceToMarkdown(seq: Sequence): string {
  const lines: string[] = [`# ${seq.name || "Untitled sequence"}`, ""];
  const emails = [...seq.emails].sort((a, b) => a.position - b.position);
  emails.forEach((email, index) => {
    lines.push(`## Email ${index + 1} — ${email.subject || "(no subject)"}`);
    lines.push(
      `_${describeDelay(email.delayHours)}${
        index === 0 ? "" : " after the previous email"
      }_`,
    );
    lines.push("");
    lines.push(email.bodyMarkdown?.trim() || "_(no body)_");
    lines.push("");
    if (index < emails.length - 1) {
      lines.push("---");
      lines.push("");
    }
  });
  return lines.join("\n").trimEnd() + "\n";
}

// ----- Profile staleness (SEQ-037) ---------------------------------------

/**
 * A profile is stale when any source was (re)ingested AFTER the profile was
 * built — the analysis no longer reflects the newest material. A source that
 * has never ingested does not make an existing profile stale on its own.
 */
export function isProfileStale(
  builtAt: string,
  sources: readonly VoiceSource[],
): boolean {
  const built = new Date(builtAt).getTime();
  if (!Number.isFinite(built)) return false;
  return sources.some((source) => {
    if (!source.lastIngestedAt) return false;
    const ingested = new Date(source.lastIngestedAt).getTime();
    return Number.isFinite(ingested) && ingested > built;
  });
}
