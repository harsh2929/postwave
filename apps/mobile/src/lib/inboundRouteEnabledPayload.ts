/**
 * lib/inboundRouteEnabledPayload.ts — the ONE PATCH body the projected off
 * switch sends, shaped so it loses nothing under EITHER revision of the
 * server's UpdateRoute handler that exists right now.
 *
 * The handler (apps/api/internal/inbound_email/routes.go, `UpdateRoute`) is
 * only partly PATCH-shaped, and a bare `{enabled}` — desktop's payload,
 * apps/desktop/src/pages/inbound-routes/useInboundRoutesController.ts:408 —
 * silently loses data:
 *
 *   - `priority` is a non-pointer int guarded by `BETWEEN 0 AND 10000`; Go's
 *     zero value 0 passes that guard, so an omitted priority RESETS to 0.
 *   - `match_subject_prefix` ($8) and `match_from_domain` ($9) are raw
 *     assignments of non-pointer strings: omitted → "" is WRITTEN and the
 *     rule's matchers are deleted.
 *   - `enabled` / `stop_on_match` / the retry fields are pointers, and
 *     `name` / `match_recipient` go through COALESCE(NULLIF($n,'')) — all
 *     safe to omit, so they are.
 *
 * `actions` is where the two handler revisions DISAGREE, and why this payload
 * sends an EMPTY ARRAY rather than an echo or an omission:
 *
 *   - Committed revision: the slice is marshalled unconditionally, and
 *     `json.Marshal` of the omitted nil slice is the string "null" →
 *     `'null'::jsonb`, a jsonb VALUE, not SQL NULL — so the `IS NULL`
 *     preserve arm misses and the ELSE arm writes JSON null over the
 *     column. Omitting wipes every action.
 *   - Working-tree revision: a nil slice is passed as SQL NULL (preserved),
 *     BUT any NON-EMPTY `actions` now enters the replace branch, which
 *     demands `expected_updated_at` (409 `route_changed` without it — and
 *     the mobile row carries no `updated_at` to send) and then runs the
 *     HMAC-secret merge, where a wire-verbatim echo — which never carries
 *     the stored secret — strips it. Echoing 409s, or wipes secrets.
 *
 *   `actions: []` with `clear_actions` absent takes the SAME arm in both:
 *   `WHEN $10::jsonb = '[]'::jsonb THEN actions` — the guard the handler's
 *   own comment keeps "so old clients that send `actions: []` by habit don't
 *   accidentally wipe everything". No CAS, no secret merge, nothing replaced.
 *   A toggle has no reason to touch actions, so it never does.
 *
 * Both revisions decode with unknown fields REJECTED (httpbody.DecodeJSON),
 * so only names both declare are sent. Import-free of react-native so the
 * node vitest beside this file can pin the shape — the assertion that keeps
 * this from regressing to desktop's bare toggle, or to an echo.
 */
import type { InboundRoute } from "./inboundRoutes";

/** Exactly what the PATCH carries: the change, the preserve echo, and `[]`. */
export interface InboundRouteEnabledPayload {
  enabled: boolean;
  priority: number;
  match_subject_prefix: string;
  match_from_domain: string;
  /** Always empty — the preserve arm of BOTH handler revisions. */
  actions: readonly [];
}

export function inboundRouteEnabledPayload(
  route: InboundRoute,
  enabled: boolean,
): InboundRouteEnabledPayload {
  return {
    enabled,
    priority: route.priority,
    match_subject_prefix: route.matchSubjectPrefix,
    match_from_domain: route.matchFromDomain,
    actions: [],
  };
}
