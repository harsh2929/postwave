/**
 * activity-cursor — the desktop half of the cross-device "resume where you left
 * off" cursor (GET/PUT `/api/v1/activity/last-viewed`, see
 * apps/api/internal/activitycursor).
 *
 * The server stores ONE `(entity_key, entity_id)` reference per user: an id
 * reference only, never entity content. Whichever device the user was last on
 * writes it; every other device can offer "Continue — Campaign".
 *
 * Why this file exists: the endpoint and the web client shipped together, and
 * desktop never adopted either. A cursor written from the web dashboard had
 * nowhere to be read, so the one feature whose entire premise is "you moved
 * devices" worked on exactly one device.
 *
 * Two things are deliberately different from the web client:
 *
 *  1. Destinations resolve through `desktopPath`, NOT `webPath`. The two
 *     surfaces own different section vocabularies (@postwave/route-map
 *     `surfaces`), so a cursor pointing at an entity desktop cannot route — a
 *     flow, a landing page — is treated as ABSENT. Offering a card whose button
 *     goes nowhere is worse than offering no card.
 *  2. Failure detection reads the `{ error }` RESULT, not just a thrown
 *     exception. Desktop's `apiRequest` resolves with an error object rather
 *     than rejecting, so a straight port of web's `try/catch` would treat every
 *     failure as a success.
 */

import { useEffect } from "react";

import {
  desktopPath,
  entityForSlug,
  getEntity,
  isEntityResourceId,
} from "@postwave/route-map";

import { EVENTS } from "@postwave/telemetry";

import { apiRequest } from "./api-client";
import { useDesktopRoute } from "./desktop-router";
import { track } from "./telemetry";

const ENDPOINT = "/api/v1/activity/last-viewed";

export interface ActivityCursor {
  entity_key: string;
  entity_id: string;
  viewed_at: string;
}

/** The slice of a desktop `apiRequest` result this module reads. */
interface CursorRequestResult<T> {
  data?: T;
  error?: { status?: number; code?: string };
}

export type CursorRequester = <T>(
  path: string,
  init?: RequestInit,
) => Promise<CursorRequestResult<T>>;

export interface ActivityCursorDeps {
  request: CursorRequester;
  /**
   * Called when a read fails for a reason that is NOT "there is simply no
   * cursor". Wired to telemetry by the default client so a 403/5xx/network
   * fault cannot hide behind an empty resume card.
   */
  onUnexpectedError?: (info: { status: number; code: string }) => void;
}

/**
 * Statuses that mean "there is no cursor to show", not "something is wrong":
 *
 *   401 — signed out
 *   404 — nothing recorded yet
 *   403 — the route is SESSION-ONLY (RequireAuthMethod(AuthMethodSession) in
 *         apps/api/internal/server/user_experience_routes.go), and both native
 *         clients also support API-key auth. A per-user continuity cursor is
 *         meaningless for a shared key, so 403 here is the API working as
 *         designed. Treating it as a fault fired this telemetry on EVERY
 *         dashboard mount in that mode — poisoning the one signal that exists
 *         to tell a broken endpoint from a quiet one.
 *
 * The server also answers 204, which surfaces as an absent `data`.
 */
const ABSENCE_STATUSES = new Set([401, 403, 404]);

/**
 * Error codes that mean "not now" rather than "broken": no network, or an
 * identity transition in flight (workspace switch, sign-out). Both are ordinary
 * desktop states and neither says anything about the endpoint's health.
 */
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
     * Record the entity being viewed. Best-effort in the strongest sense: a
     * failure here must never disturb the screen the user actually came for,
     * so every outcome resolves void. Only references route-map itself accepts
     * are sent, so a bad id is dropped locally rather than becoming a 400.
     */
    async recordLastViewed(entityKey: string, entityId: string): Promise<void> {
      if (!isEntityResourceId(entityKey, entityId)) return;
      try {
        await request<void>(ENDPOINT, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity_key: entityKey, entity_id: entityId }),
        });
      } catch {
        // Swallow — see doc comment. An `{ error }` result is likewise ignored;
        // there is no user-visible recovery for a continuity write.
      }
    },

    /**
     * Read the cursor, or null when there is none, the caller is signed out, or
     * the reference does not resolve to a destination THIS surface can open.
     */
    async fetchLastViewed(): Promise<ActivityCursor | null> {
      let result: CursorRequestResult<ActivityCursor>;
      try {
        result = await request<ActivityCursor>(ENDPOINT, { method: "GET" });
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
      // The registry decides whether this surface can open it. Doing the check
      // here (rather than in the card) means every consumer of the cursor gets
      // the same answer.
      if (!resumeHref(raw)) return null;
      return raw;
    },
  };
}

/**
 * The desktop in-app route for a cursor, or null when this surface cannot open
 * that entity. Uses `desktopPath` so the destination is identical to every
 * other route-map consumer on this client.
 */
export function resumeHref(cursor: ActivityCursor): string | null {
  if (!isEntityResourceId(cursor.entity_key, cursor.entity_id)) return null;
  return desktopPath(cursor.entity_key, cursor.entity_id);
}

/**
 * Human label for the entity TYPE behind a cursor ("campaign" → "Campaign",
 * "helpdesk-conversation" → "Helpdesk conversation").
 *
 * The type, never the entity: the cursor stores an id reference and no content,
 * so there is no title to render. Showing one would imply the server keeps
 * something it deliberately does not.
 */
export function resumeTypeLabel(cursor: ActivityCursor): string {
  const key = getEntity(cursor.entity_key)?.key ?? cursor.entity_key;
  const spaced = key.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The live client, bound to the desktop API layer. Unexpected read failures go
 * to telemetry rather than being folded into "no cursor" — an empty resume card
 * and a broken endpoint must not look identical in the data.
 */
export const activityCursor = createActivityCursorClient({
  // `apiRequest` returns the full desktop ApiResult union (queued receipts,
  // retryability, server versions); this module only reads `data` and `error`,
  // so the cast narrows to the slice it uses rather than importing the union.
  request: <T>(path: string, init?: RequestInit) =>
    apiRequest<T>(path, init) as Promise<CursorRequestResult<T>>,
  onUnexpectedError: ({ status, code }) =>
    track(EVENTS.CONTINUITY_RESUME_READ_FAILED, { status, code }),
});

/**
 * Record the current route as the resume cursor.
 *
 * Driven by the ROUTE rather than by each detail page. Desktop's router already
 * parses `/app/<slug>/<resourceId>` into `{ section, resourceId }` for every
 * section, so one hook mounted at the shell covers every entity the registry
 * knows — including ones added later. The per-page alternative (web's
 * `<RecordLastViewed>`) needs an edit in every detail view and silently misses
 * the ones nobody remembers.
 *
 * `entityForSlug` is the bridge: the router speaks sections, the cursor speaks
 * entity keys, and the registry maps between them. A section with no registered
 * entity (settings, audit) simply records nothing.
 *
 * The router's section KEY is used directly as the slug. That is exact today,
 * not a shortcut: of desktop's 55 sections, the 17 whose key differs from their
 * slug (`audienceSyncs`→`audience-syncs`, `deliverabilityHub`, `sendtime`, …)
 * are all sections no route-map entity claims, and every one of the 13
 * desktop-routable entity slugs belongs to a section whose key equals its slug.
 * `scripts/check-route-map-destinations.mjs` fails if an entity slug stops
 * being a desktop section, which is the condition that would break this.
 */
export function useRecordRouteAsResumeCursor(): void {
  const route = useDesktopRoute();
  const slug = route.section;
  const entity = entityForSlug(slug);
  const resourceId = route.resourceId;

  useEffect(() => {
    if (!entity || !resourceId) return;
    void activityCursor.recordLastViewed(entity.key, resourceId);
  }, [entity, resourceId]);
}

/**
 * Invisible mount point for the recorder. Rendered once inside the shell
 * (App.tsx), alongside the cache invalidator. Returns null — its only job is to
 * keep the hook alive for the lifetime of the session.
 */
export function ResumeCursorRecorder(): null {
  useRecordRouteAsResumeCursor();
  return null;
}
