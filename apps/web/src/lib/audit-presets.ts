// SPDX-License-Identifier: AGPL-3.0-only
//
// Quick-filter presets for the audit log (SETA-042). Common investigations
// (last 24h/7d/30d, deletions, API-key changes) become one-click chips instead
// of retyping four inputs + two date pickers. Pure + dependency-free so the
// filter math is unit-tested in node; `now` is injectable for determinism.

import type { AuditFilters } from "@/lib/audit-api";

export interface AuditPreset {
  id: string;
  label: string;
}

export const AUDIT_PRESETS: readonly AuditPreset[] = [
  { id: "last-24h", label: "Last 24h" },
  { id: "last-7d", label: "Last 7 days" },
  { id: "last-30d", label: "Last 30 days" },
  { id: "deletions", label: "Deletions" },
  { id: "api-key-activity", label: "API-key changes" },
] as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** ISO timestamp for `hours` before `now`. */
export function windowSince(hours: number, now: number = Date.now()): string {
  return new Date(now - hours * HOUR_MS).toISOString();
}

/**
 * The `AuditFilters` a preset applies. Time-window presets set `since` (and
 * clear other fields); field presets set the relevant field and leave time
 * open. `limit` is preserved by the caller when merging.
 */
export function auditPresetFilters(
  id: string,
  now: number = Date.now(),
): AuditFilters {
  switch (id) {
    case "last-24h":
      return { since: new Date(now - DAY_MS).toISOString() };
    case "last-7d":
      return { since: new Date(now - 7 * DAY_MS).toISOString() };
    case "last-30d":
      return { since: new Date(now - 30 * DAY_MS).toISOString() };
    case "deletions":
      return { action: "delete" };
    case "api-key-activity":
      // API calls retain their human/agent actor type. Key handlers use the
      // generic mutation auditor, whose action contains the API route path.
      return { action: ".api.v1.api-keys" };
    default:
      return {};
  }
}

/**
 * The actor type the "AI activity" chip pivots to (governance-7).
 *
 * Agent API keys and installed marketplace apps are written as `agent` (see
 * ACTOR_TYPES on the audit page, pinned against the Go source). An EU AI Act
 * Article 50 reviewer scopes to AI-only activity with one click instead of
 * remembering which dropdown value means "the AI".
 */
export const AI_ACTIVITY_ACTOR_TYPE = "agent" as const;

/**
 * One-click action-category chips (governance-9). Each maps to ONE literal
 * action substring — the same value a person would type into "Action
 * contains" — so a chip is a shortcut for the free-text filter, not a second
 * filter language. Mirrors desktop's categoryToActionParam.
 */
export interface AuditActionCategory {
  id: string;
  label: string;
  /** The `action` substring the chip applies. */
  action: string;
  description: string;
}

export const AUDIT_ACTION_CATEGORIES: readonly AuditActionCategory[] = [
  {
    id: "destructive",
    label: "Destructive",
    action: "delete",
    description: "Action contains “delete”",
  },
  {
    id: "auth",
    label: "Auth",
    action: "login",
    description: "Action contains “login”",
  },
  {
    id: "export",
    label: "Export",
    action: "export",
    description: "Action contains “export”",
  },
  {
    // One-click unsubscribe (RFC 8058) revocations: the consent ledger and
    // the suppression repo both tag those rows with `one_click`.
    id: "one-click",
    label: "One-click",
    action: "one_click",
    description: "Action contains “one_click”",
  },
  {
    // Meta-audit rows written by AuditMetaMiddleware: list / export / stream
    // / stats / saved-view / retention reads all surface together.
    id: "audit-reads",
    label: "Audit reads",
    action: "audit.read",
    description: "Action contains “audit.read”",
  },
] as const;

/**
 * The category chip the current `action` filter represents, or null when the
 * filter is free text (or empty). Exact match on purpose: "delete" lights the
 * Destructive chip, "campaign.delete" does not — a lit chip claims to BE the
 * applied filter, and lighting it over a narrower one would misreport it.
 */
export function auditActionCategoryFor(
  action: string,
): AuditActionCategory | null {
  return AUDIT_ACTION_CATEGORIES.find((c) => c.action === action) ?? null;
}
