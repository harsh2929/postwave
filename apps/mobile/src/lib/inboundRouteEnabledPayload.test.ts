/**
 * The projected off switch's PATCH body, pinned against BOTH revisions of the
 * server's UpdateRoute handler.
 *
 * Three ways this body can regress, each fatal on at least one revision:
 *   - dropping the echo (desktop's bare `{enabled}`) → priority reset to 0
 *     and both matchers wiped, on both revisions;
 *   - omitting `actions` → JSON null written over the column on the committed
 *     revision;
 *   - echoing the route's actions → 409 `route_changed` (no CAS token) or a
 *     stripped webhook HMAC secret on the working-tree revision.
 * These tests fail on every one of them.
 */
import { describe, expect, it } from "vitest";

import { inboundRouteEnabledPayload } from "./inboundRouteEnabledPayload";
import type { InboundRoute } from "./inboundRoutes";

const wireActions = [
  {
    kind: "webhook",
    url: "https://hooks.example/inbound",
    has_stored_hmac_secret: true,
    extra: { secret_ref: "wh-7" },
  },
] as const;

const route: InboundRoute = {
  id: "r-1",
  name: "Support replies",
  priority: 120,
  stopOnMatch: true,
  enabled: true,
  matchRecipient: "support@*",
  matchSubjectPrefix: "[case]",
  matchFromDomain: "customer.example",
  actions: [
    { kind: "webhook", tag: "", eventType: "", url: "https://hooks.example/inbound", to: "" },
  ],
  rawActions: wireActions,
  lastMatchedAt: "",
  matchCount: 4,
  actionRetryMax: 0,
};

describe("inboundRouteEnabledPayload", () => {
  it("carries the toggle in both directions", () => {
    expect(inboundRouteEnabledPayload(route, false).enabled).toBe(false);
    expect(inboundRouteEnabledPayload(route, true).enabled).toBe(true);
  });

  it("echoes every field the partial PATCH would otherwise zero", () => {
    const payload = inboundRouteEnabledPayload(route, false);
    // Non-pointer int: omitted → 0, and 0 passes the BETWEEN guard.
    expect(payload.priority).toBe(120);
    // $8/$9 are raw assignments: omitted → "" written, matchers deleted.
    expect(payload.match_subject_prefix).toBe("[case]");
    expect(payload.match_from_domain).toBe("customer.example");
  });

  it("echoes empty matchers as empty rather than inventing values", () => {
    const bare = { ...route, matchSubjectPrefix: "", matchFromDomain: "" };
    const payload = inboundRouteEnabledPayload(bare, false);
    expect(payload.match_subject_prefix).toBe("");
    expect(payload.match_from_domain).toBe("");
  });

  it("sends actions as [] — NEVER the route's actions, NEVER omitted", () => {
    // The route HAS actions on the wire; the toggle still sends the empty
    // array, because that is the one arm both handler revisions treat as
    // "keep what is stored" without a CAS token or a secret merge.
    const payload = inboundRouteEnabledPayload(route, false);
    expect(payload.actions).toEqual([]);
    expect(payload.actions).not.toBe(route.rawActions);
    expect(Object.prototype.hasOwnProperty.call(payload, "actions")).toBe(true);
  });

  it("sends [] for an action-less rule too", () => {
    expect(
      inboundRouteEnabledPayload({ ...route, actions: [], rawActions: [] }, true)
        .actions,
    ).toEqual([]);
  });

  it("sends NOTHING else — no clear_actions, no CAS token, no name/recipient/retry", () => {
    // `clear_actions: true` beside `[]` would WIPE the actions instead of
    // preserving them; `expected_updated_at` is not a field the committed
    // revision declares, and both decoders reject unknown fields.
    expect(Object.keys(inboundRouteEnabledPayload(route, false)).sort()).toEqual(
      ["actions", "enabled", "match_from_domain", "match_subject_prefix", "priority"],
    );
  });

  it("does not mutate the route it reads", () => {
    const frozen = Object.freeze({ ...route });
    expect(() => inboundRouteEnabledPayload(frozen, false)).not.toThrow();
    expect(frozen.enabled).toBe(true);
    expect(frozen.rawActions).toBe(wireActions);
  });
});
