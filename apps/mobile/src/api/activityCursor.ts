/**
 * api/activityCursor.ts — the mobile half of the cross-device "resume where you
 * left off" cursor (GET/PUT `/api/v1/activity/last-viewed`, see
 * apps/api/internal/activitycursor).
 *
 * The server keeps ONE `(entity_key, entity_id)` reference per user — an id
 * reference, never entity content. Whichever device the user was last on writes
 * it; every other device can offer "Continue — Campaign".
 *
 * The endpoint and the web client shipped together and neither native client
 * ever adopted it, so a feature whose whole premise is "you changed devices"
 * only worked on one. Phone is the device you most often pick up SECOND.
 *
 * Destinations resolve through `mobilePath`, so the registry decides what this
 * app can open: an entity with no mobile screen (an affiliate — there is no
 * Affiliates tab) yields null and the card is simply not shown. A cursor for an
 * entity with a list but no detail screen (a template) lands on the list, which
 * is the closest reachable destination rather than a dead route.
 */
import { getEntity, isSafeResourceId, mobilePath } from "@postwave/route-map";

const ENDPOINT = "/api/v1/activity/last-viewed";

export interface ActivityCursor {
  entity_key: string;
  entity_id: string;
  viewed_at: string;
}

/** The slice of the mobile result envelope this module reads. */
export interface CursorResult<T> {
  data: T | null;
  error: { status?: number; code?: string } | null;
}

export type CursorRequester = <T>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<CursorResult<T>>;

export interface ActivityCursorDeps {
  request: CursorRequester;
  /**
   * Called when a read fails for a reason that is NOT "there is no cursor", so
   * a 403/5xx/network fault cannot hide behind an empty resume card.
   */
  onUnexpectedError?: (info: { status: number; code: string }) => void;
}

/**
 * Statuses that mean "there is no cursor", not "something is wrong":
 *   401 — signed out
 *   404 — nothing recorded yet
 *   403 — the route is SESSION-ONLY (RequireAuthMethod(AuthMethodSession)), and
 *         this app also supports API-key auth. A per-user continuity cursor is
 *         meaningless for a shared key, so 403 is the API behaving correctly.
 *         Reporting it would fire this telemetry on every dashboard mount in
 *         that mode and drown the signal it exists to provide.
 */
const ABSENCE_STATUSES = new Set([401, 403, 404]);

/** Codes that mean "not now" rather than "broken" — offline, mid-transition. */
const ABSENCE_CODES = new Set([
  "offline",
  "network_error",
  "identity_transition",
  "insufficient_auth_method",
]);

export interface ActivityCursorClient {
  recordLastViewed(entityKey: string, entityId: string): Promise<void>;
  fetchLastViewed(): Promise<ActivityCursor | null>;
}

export function createActivityCursorClient(
  deps: ActivityCursorDeps,
): ActivityCursorClient {
  const { request, onUnexpectedError } = deps;

  return {
    /**
     * Record the entity being viewed. Resolves void on every outcome: a phone
     * on a flaky train connection must not turn a continuity nicety into a
     * visible failure on the screen the user actually opened.
     *
     * Deliberately NOT routed through the offline outbox. A resume cursor is
     * last-write-wins presence, so replaying a stale one hours later would
     * point every other device at whatever the user happened to open before
     * losing signal — worse than having no cursor at all.
     */
    async recordLastViewed(entityKey: string, entityId: string): Promise<void> {
      if (!getEntity(entityKey) || !isSafeResourceId(entityId)) return;
      try {
        await request<null>("PUT", ENDPOINT, {
          entity_key: entityKey,
          entity_id: entityId,
        });
      } catch {
        // Swallow — see doc comment. An `{ error }` result is ignored for the
        // same reason: there is no user-visible recovery for this write.
      }
    },

    /**
     * Read the cursor, or null when there is none, the caller is signed out, or
     * the reference does not resolve to a screen this app has.
     */
    async fetchLastViewed(): Promise<ActivityCursor | null> {
      let result: CursorResult<ActivityCursor>;
      try {
        result = await request<ActivityCursor>("GET", ENDPOINT);
      } catch {
        onUnexpectedError?.({ status: 0, code: "network_error" });
        return null;
      }
      if (result.error) {
        const status = result.error.status ?? 0;
        const code = result.error.code ?? "unknown_error";
        if (!ABSENCE_STATUSES.has(status) && !ABSENCE_CODES.has(code)) {
          onUnexpectedError?.({ status, code });
        }
        return null;
      }
      const raw = result.data;
      if (!raw || !raw.entity_key || !raw.entity_id) return null;
      if (!resumeRoute(raw)) return null;
      return raw;
    },
  };
}

/**
 * The in-app route for a cursor, or null when this app cannot open that entity.
 * Uses `mobilePath` so the destination matches every other route-map consumer
 * on this client (deep links, share handoff, notification routes).
 */
export function resumeRoute(cursor: ActivityCursor): string | null {
  if (!isSafeResourceId(cursor.entity_id)) return null;
  return mobilePath(cursor.entity_key, cursor.entity_id);
}

/**
 * Human label for the entity TYPE ("campaign" → "Campaign",
 * "helpdesk-conversation" → "Helpdesk conversation"). The type, never the entity — the cursor stores an id
 * reference and no content, so there is no title to show.
 */
export function resumeTypeLabel(cursor: ActivityCursor): string {
  const key = getEntity(cursor.entity_key)?.key ?? cursor.entity_key;
  const spaced = key.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// The bound client and the React hook deliberately live in
// hooks/useActivityCursor.ts, NOT here. This module must stay importable in the
// node vitest environment: pulling in the transport (and through it React
// Native) would make every test above require the RN runtime, and the rules
// this file encodes — which references are valid, which entities this surface
// can open — are exactly the ones worth testing without a simulator.
