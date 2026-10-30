// SPDX-License-Identifier: AGPL-3.0-only
//
// Grouping / search / CTA-verb helpers for the migration source catalogue.
// The picker renders 20 capability-driven sources; these pure helpers back the
// search box and ESP/CRM/File-upload grouping (MIGR-020) and derive the card
// CTA verb from the connection type ("Upload" for file sources, "Connect"
// otherwise — MIGR-030), so the same logic is unit-testable in isolation.

import { SOURCE_LABELS, type AdapterCapabilities } from "./types";

export type MigrationSourceCategory = "esp" | "crm" | "file";

export interface MigrationSourceGroup {
  category: MigrationSourceCategory;
  label: string;
  caps: AdapterCapabilities[];
}

const CATEGORY_LABELS: Record<MigrationSourceCategory, string> = {
  esp: "Email & marketing platforms",
  crm: "CRM",
  file: "File upload",
};

// Sources that are CRM systems of record rather than ESPs.
const CRM_SOURCES = new Set<string>(["hubspot"]);

/** Which group a source belongs to, from its auth method + known CRM set. */
export function migrationSourceCategory(
  cap: AdapterCapabilities,
): MigrationSourceCategory {
  if (cap.auth_method === "csv_upload") return "file";
  if (CRM_SOURCES.has(cap.source)) return "crm";
  return "esp";
}

export function migrationSourceCategoryLabel(
  category: MigrationSourceCategory,
): string {
  return CATEGORY_LABELS[category];
}

/** Card CTA verb: file-upload sources "Upload", everything else "Connect". */
export function migrationSourceCtaVerb(cap: AdapterCapabilities): string {
  return cap.auth_method === "csv_upload" ? "Upload" : "Connect";
}

/** Case-insensitive match over the source's display label and slug. */
export function capabilityMatchesSearch(
  cap: AdapterCapabilities,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const label = (SOURCE_LABELS[cap.source] ?? cap.source).toLowerCase();
  return label.includes(q) || cap.source.toLowerCase().includes(q);
}

export function filterCapabilities(
  caps: AdapterCapabilities[],
  query: string,
): AdapterCapabilities[] {
  return caps.filter((cap) => capabilityMatchesSearch(cap, query));
}

const GROUP_ORDER: MigrationSourceCategory[] = ["esp", "crm", "file"];

/**
 * Group capabilities into ESP / CRM / File-upload sections in a stable order,
 * dropping empty groups. Card order within a group is preserved from input.
 */
export function groupCapabilities(
  caps: AdapterCapabilities[],
): MigrationSourceGroup[] {
  const byCategory = new Map<MigrationSourceCategory, AdapterCapabilities[]>();
  for (const cap of caps) {
    const category = migrationSourceCategory(cap);
    const bucket = byCategory.get(category) ?? [];
    bucket.push(cap);
    byCategory.set(category, bucket);
  }
  return GROUP_ORDER.flatMap((category) => {
    const group = byCategory.get(category);
    if (!group || group.length === 0) return [];
    return [{ category, label: CATEGORY_LABELS[category], caps: group }];
  });
}
