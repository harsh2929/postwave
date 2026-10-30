/**
 * api/lookalikeAudiences.ts — transport for first-party lookalike audiences.
 *
 * WHICH FAMILY, AND WHY. Two lookalike route families are mounted and only one
 * of them can back a monitor. `/api/v1/audiences/lookalike`
 * (audiences/handlers.go:37-45) has POST, GET /{id}, GET /{id}/members and
 * DELETE — and NO LIST. `/api/v1/subscribers/lookalike`
 * (subscribers/lookalike.go:461-471) has the list. A phone surface needs
 * something to open, so this module talks to the subscribers family. Both are
 * live and write to separate tables, so this is a genuine choice rather than a
 * preference; the header of lib/lookalikeAudiences carries the full comparison.
 *
 * THE GUARDS, READ OFF THE MOUNT RATHER THAN THE MANIFEST:
 *
 *   GET  /api/v1/subscribers/lookalike        RequireScope(read:subscribers)
 *   GET  /api/v1/subscribers/lookalike/{id}   RequireScope(read:subscribers)
 *
 * `ScopeReadSubscribers` is in the `readOnlyScopes` allowlist
 * (apikeys/middleware.go:332-337), so `requireAdminRoleForScopes` is false and
 * ANY authenticated dashboard session clears both reads — viewer included. That
 * is the whole authorization story for this surface, because it has no writes.
 *
 * DELIBERATELY NOT HERE, each for a reason rather than for time:
 *
 *   - POST /api/v1/subscribers/lookalike (generate). Three separate reasons,
 *     any one of which would be enough:
 *       (a) `data_use_acknowledged` must be true or the request is refused
 *           (lookalike.go:74), and the value persisted alongside it is a
 *           versioned compliance record — `data_use_notice_version:
 *           "first-party-lookalike-v1"` (lookalike.go:158-162). A phone tick-box
 *           without the full first-party data-use notice would file an
 *           acknowledgement nobody actually read. That is not a form we should
 *           make smaller; it is one we should not move.
 *       (b) It is SYNCHRONOUS and heavy: one transaction loads up to 20,000
 *           seed profiles and 50,000 candidates, ranks them, then inserts the
 *           members one row at a time in a Go loop (lookalike.go:182-196). On
 *           cellular that outlives the client timeout while the server keeps
 *           going and COMMITS, and there is no idempotency key on the route —
 *           so a retry is a second audience, not the same one.
 *       (c) The seed is a saved segment chosen from the whole catalogue, with a
 *           size and a confidence floor. That is desktop work.
 *   - DELETE /{id}. Cascades every materialised member with no undo anywhere in
 *     the API, and "tidy up an old model" is not a thing anyone needs to do at
 *     9pm from a phone.
 *   - POST /{id}/export. Worth stating precisely because the name misleads: it
 *     does NOT download anything and does NOT deliver anything. It writes an
 *     `audience_destinations` id onto the row, and the repo comment says so
 *     outright — "It does not start provider delivery; operators use the
 *     audience-sync workflow for that separate, observable action"
 *     (lookalike.go:322-324). Delivery is the audience-syncs surface, which
 *     mobile already has. Offering an "Export" button here would imply a
 *     handoff that does not happen.
 *
 * Parsing lives in lib/lookalikeAudiences so it is unit-testable in the node
 * vitest environment; this module is only URLs and envelopes.
 */
import {
  LOOKALIKE_MEMBER_SAMPLE_SIZE,
  parseLookalikeAudienceList,
  parseLookalikeMemberPage,
  type LookalikeAudience,
  type LookalikeMemberPage,
} from "@/lib/lookalikeAudiences";

import { checkedApiResult, rawRequest } from "./request";

export const LOOKALIKE_PATH = "/api/v1/subscribers/lookalike";

export function lookalikeAudiencePath(id: string): string {
  return `${LOOKALIKE_PATH}/${encodeURIComponent(id)}`;
}

/**
 * The catalogue, newest first — `ORDER BY created_at DESC` is in the query
 * itself (lookalike.go:210), so the screen's own ordering is a re-sort of an
 * already-deterministic list rather than an attempt to impose one.
 *
 * There is NO pagination on this route: `ListLookalikes` selects every row for
 * the tenant with no LIMIT and no cursor. Nothing here should imply otherwise.
 */
export async function fetchLookalikeAudiences(): Promise<LookalikeAudience[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", LOOKALIKE_PATH),
  );
  return parseLookalikeAudienceList(res.data);
}

/**
 * One audience's ranked members. `include_pii=true` is REQUIRED or the handler
 * returns an empty array with `pii_included:false` (lookalike.go:262) — the
 * server's own default is aggregate-only precisely so a status poll cannot
 * hydrate subscriber identities. This function is therefore only ever called
 * from an explicit human action, never on mount.
 *
 * The header is dropped rather than returned: `GetLookalike` selects the same
 * fourteen columns the list already delivered (lookalike.go:250-255 vs
 * :206-211), so re-reading it here would only create a second copy of the same
 * row that could disagree with the one on screen.
 */
export async function fetchLookalikeMembers(
  id: string,
  perPage: number = LOOKALIKE_MEMBER_SAMPLE_SIZE,
): Promise<LookalikeMemberPage> {
  const query = `?page=1&per_page=${encodeURIComponent(String(perPage))}&include_pii=true`;
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${lookalikeAudiencePath(id)}${query}`),
  );
  return parseLookalikeMemberPage(res.data);
}
