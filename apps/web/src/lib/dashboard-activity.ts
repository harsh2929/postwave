// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure helpers that turn raw audit_log rows into a human workspace-activity
// feed for the dashboard home. Three concerns (OVR-003 / OVR-020):
//   1. drop internal "http.*" request-log plumbing rows,
//   2. map action codes to human sentences (verb + object + actor),
//   3. collapse consecutive identical events into one row with a count.
// Kept dependency-light and side-effect-free so it can be unit-tested and
// reused by any client that reads the audit log.

import { isSafeResourceId, webPath } from "@postwave/route-map";

import type { AuditRow } from "@/lib/audit-api";

/** A single (possibly grouped) activity feed entry. */
export interface ActivityItem {
  /** Stable key (the id of the most recent event in the group). */
  id: string;
  /** Human-readable line, e.g. "Sent a campaign · Ada". */
  message: string;
  /** ISO timestamp of the most recent event in the group. */
  at: string;
  /** How many consecutive identical events this row represents (>= 1). */
  count: number;
  /** In-app link to the referenced entity, or null when unresolvable. */
  href: string | null;
}

// Known action verbs → past-tense sentence forms. Audit actions are
// dot-delimited (e.g. "campaign.send", "subscriber.create"); the trailing
// segment is the verb. Unknown verbs fall back to a readable phrase.
const VERB_PAST: Record<string, string> = {
  create: "created",
  created: "created",
  add: "added",
  added: "added",
  update: "updated",
  updated: "updated",
  edit: "edited",
  delete: "deleted",
  deleted: "deleted",
  remove: "removed",
  removed: "removed",
  send: "sent",
  sent: "sent",
  queue: "queued",
  queued: "queued",
  schedule: "scheduled",
  scheduled: "scheduled",
  pause: "paused",
  resume: "resumed",
  cancel: "cancelled",
  cancelled: "cancelled",
  import: "imported",
  imported: "imported",
  export: "exported",
  exported: "exported",
  archive: "archived",
  enable: "enabled",
  disable: "disabled",
  login: "signed in",
  logout: "signed out",
  invite: "invited",
  approve: "approved",
  reject: "rejected",
};

const STARTS_WITH_VOWEL = /^[aeiou]/i;

/** Normalize dot/underscore/dash-delimited tokens into a spaced phrase. */
function humanizeToken(value: string): string {
  return value.replace(/[._-]+/g, " ").trim();
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * True for internal HTTP request-log rows the audit middleware emits
 * (e.g. "http.post.api.v1.onboarding.sample-data"). These are developer/ops
 * plumbing, not workspace activity, and are dropped from the feed.
 */
export function isPlumbingAction(action: string | null | undefined): boolean {
  const normalized = (action ?? "").trim().toLowerCase();
  return (
    normalized === "http" ||
    normalized.startsWith("http.") ||
    normalized.startsWith("http ")
  );
}

/**
 * Turn one audit row into a human sentence. Prefers the row's resourceType as
 * the object; appends the actor label when present. Never throws.
 */
export function humanizeAuditRow(row: AuditRow): string {
  const rawAction = (row.action ?? "").trim().toLowerCase();
  const actor = row.actorLabel?.trim();
  const segments = rawAction.split(".").filter(Boolean);

  let message: string;
  if (segments.length === 0) {
    message = "Activity";
  } else {
    const verb = segments[segments.length - 1]!;
    const derivedResource =
      segments.length > 1 ? segments.slice(0, -1).join(" ") : "";
    const resource = humanizeToken(
      row.resourceType?.trim() || derivedResource || segments[0]!,
    );
    const past = VERB_PAST[verb];
    if (past) {
      if (resource) {
        const article = STARTS_WITH_VOWEL.test(resource) ? "an" : "a";
        message = `${titleCase(past)} ${article} ${resource}`;
      } else {
        message = titleCase(past);
      }
    } else {
      // Unknown verb — render the full action as a readable phrase so nothing
      // is lost (e.g. "segment.decay" → "Segment decay").
      message = titleCase(humanizeToken(rawAction));
    }
  }

  return actor ? `${message} · ${actor}` : message;
}

/**
 * In-app link to the entity an audit row references, via the shared route-map
 * (the same source of truth the resume card / copy-link controls use). Returns
 * null when the resource type/id are missing, unsafe, or unmapped.
 */
export function activityEntityHref(row: AuditRow): string | null {
  const type = row.resourceType?.trim();
  const id = row.resourceId?.trim();
  if (!type || !id) return null;
  if (!isSafeResourceId(id)) return null;
  return webPath(type, id);
}

/**
 * Build the rendered activity feed from raw audit rows (newest first):
 * drop plumbing rows, humanize, then collapse consecutive identical messages
 * into a single row carrying a `count`.
 */
export function buildActivityItems(rows: readonly AuditRow[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const row of rows) {
    if (isPlumbingAction(row.action)) continue;
    const message = humanizeAuditRow(row);
    const prev = items[items.length - 1];
    if (prev && prev.message === message) {
      prev.count += 1;
      continue;
    }
    items.push({
      id: `audit-${row.id}`,
      message,
      at: row.at,
      count: 1,
      href: activityEntityHref(row),
    });
  }
  return items;
}
