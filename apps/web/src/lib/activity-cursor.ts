// SPDX-License-Identifier: AGPL-3.0-only
//
// Client for the cross-device "resume where you left off" cursor
// (Apple-level integration Phase 1 — Continuity). The server stores one
// (entity_key, entity_id) reference per user (see apps/api/internal/
// activitycursor); this module records it when a detail view mounts and reads
// it back to power the dashboard "Continue where you left off" card.
//
// The stored value is an ID reference only — never entity content — so the
// resume card names the entity *type* and when it was seen, and resolves the
// destination route through the shared @postwave/route-map registry (the same
// source of truth the "Copy link / open in app" control uses). We never
// hand-roll the slug/route here.

import { getEntity, isSafeResourceId, webPath } from "@postwave/route-map";

import { api, isApiError } from "@/lib/api";
import { track } from "@/lib/telemetry";

const ENDPOINT = "/api/v1/activity/last-viewed";

export interface ActivityCursor {
  entity_key: string;
  entity_id: string;
  viewed_at: string;
}

/**
 * Record the entity the user is currently viewing as their resume cursor.
 * Best-effort: continuity is a convenience, so a failure (offline, transient
 * 5xx, signed-out) must never disrupt the page the user came to see. We only
 * send references route-map itself accepts, so a bad id is dropped client-side
 * rather than round-tripping to a 400.
 */
export async function recordLastViewed(
  entityKey: string,
  entityId: string,
): Promise<void> {
  if (!getEntity(entityKey) || !isSafeResourceId(entityId)) return;
  try {
    await api.put(ENDPOINT, { entity_key: entityKey, entity_id: entityId });
  } catch {
    // Swallow — see doc comment. Never surface a continuity write failure.
  }
}

/**
 * Read the user's resume cursor, or `null` when none is set (the server
 * answers 204, which the api client surfaces as `undefined`) or when the
 * caller is signed out. Only returns a cursor that still resolves to a known
 * route — a reference to an entity type this build no longer maps is treated
 * as absent rather than rendered as a dead link.
 */
export async function fetchLastViewed(): Promise<ActivityCursor | null> {
  let raw: ActivityCursor | undefined;
  try {
    raw = await api.get<ActivityCursor | undefined>(ENDPOINT);
  } catch (err) {
    // 401 (signed out) and 404 (no cursor recorded) are the expected "there is
    // simply no cursor" outcomes — stay silent so the dashboard just omits the
    // card. An unexpected 403 / 5xx / network failure is a REAL problem, not an
    // absence of data; record it to telemetry so it isn't masked as "no cursor"
    // (OVR-030). We still return null so continuity stays best-effort.
    if (isApiError(err) && (err.status === 401 || err.status === 404)) {
      return null;
    }
    track("resume_cursor_read_failed", {
      status: isApiError(err) ? err.status : 0,
      code: isApiError(err) ? err.code : "network_error",
    });
    return null;
  }
  if (!raw || !raw.entity_key || !raw.entity_id) return null;
  if (!resumeHref(raw)) return null;
  return raw;
}

/**
 * The in-app route for a cursor, or `null` when route-map rejects it. Uses
 * webPath so the destination stays identical to every other route-map
 * consumer.
 */
export function resumeHref(cursor: ActivityCursor): string | null {
  return webPath(cursor.entity_key, cursor.entity_id);
}

/**
 * Human label for the entity *type* behind a cursor (e.g. "campaign" →
 * "Campaign"). We deliberately name the type, not the entity itself, because
 * the cursor stores no content — only a reference.
 */
export function resumeTypeLabel(cursor: ActivityCursor): string {
  const key = getEntity(cursor.entity_key)?.key ?? cursor.entity_key;
  return key.charAt(0).toUpperCase() + key.slice(1);
}
