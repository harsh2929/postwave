/**
 * The toggle payload's PRESERVE ECHO, pinned.
 *
 * The server's PATCH raw-assigns `match_subject_prefix` ($8) and
 * `match_from_domain` ($9) and passes a non-pointer `priority` whose zero
 * value survives the `BETWEEN 0 AND 10000` guard — so a payload that carries
 * only `{enabled}` (desktop's bug) silently wipes both matchers and resets
 * the priority. These tests fail if anyone "simplifies" the payload back to
 * the bare toggle.
 */
import { describe, expect, it } from "vitest";

import {
  disableConfirmCopy,
  InboundRouteOfflineError,
  inboundRouteTogglePayload,
  toggleVerb,
} from "./inboundRouteToggle";
import type { InboundRoute } from "./inboundRoutes";

/**
 * The wire-verbatim action carries an `extra` map the mobile normalizer drops
 * — the fixture keeps one so the tests below can prove the payload echoes the
 * RAW array, not the lossy normalized one.
 */
const wireActions = [
  {
    kind: "webhook",
    url: "https://hooks.example/inbound",
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

describe("inboundRouteTogglePayload", () => {
  it("carries the toggle", () => {
    expect(inboundRouteTogglePayload(route, false).enabled).toBe(false);
    expect(inboundRouteTogglePayload(route, true).enabled).toBe(true);
  });

  it("echoes every field the server's partial PATCH would otherwise zero", () => {
    const payload = inboundRouteTogglePayload(route, false);
    // priority is a non-pointer int on the server: omitted → written as 0.
    expect(payload.priority).toBe(120);
    // $8/$9 are raw assignments: omitted → matchers deleted.
    expect(payload.match_subject_prefix).toBe("[case]");
    expect(payload.match_from_domain).toBe("customer.example");
  });

  it("echoes empty matchers as empty rather than inventing values", () => {
    const bare = { ...route, matchSubjectPrefix: "", matchFromDomain: "" };
    const payload = inboundRouteTogglePayload(bare, false);
    expect(payload.match_subject_prefix).toBe("");
    expect(payload.match_from_domain).toBe("");
  });

  it("echoes the WIRE-VERBATIM actions, not the lossy normalized ones", () => {
    // Omitting `actions` does NOT preserve them: the server marshals the
    // omitted slice to the string "null" and `'null'::jsonb IS NULL` is false,
    // so the column is overwritten with JSON null. And the normalized actions
    // drop each action's `extra` map, so echoing THOSE would strip webhook
    // config. Only route.rawActions is safe to send.
    const payload = inboundRouteTogglePayload(route, false);
    expect(payload.actions).toBe(route.rawActions);
    expect(payload.actions).toEqual([
      {
        kind: "webhook",
        url: "https://hooks.example/inbound",
        extra: { secret_ref: "wh-7" },
      },
    ]);
  });

  it("echoes an action-less rule as [] — the server's empty-array-preserve arm", () => {
    const payload = inboundRouteTogglePayload(
      { ...route, actions: [], rawActions: [] },
      false,
    );
    expect(payload.actions).toEqual([]);
  });

  it("sends NOTHING else — name/recipient/retry fields are preserved by omission", () => {
    // `clear_actions` in particular must never appear: paired with an empty
    // echo it would WIPE the rule's actions instead of preserving them.
    expect(Object.keys(inboundRouteTogglePayload(route, false)).sort()).toEqual(
      ["actions", "enabled", "match_from_domain", "match_subject_prefix", "priority"],
    );
  });
});

describe("toggle copy", () => {
  it("confirms the OFF direction with the rule's name and the consequence", () => {
    const copy = disableConfirmCopy(route);
    expect(copy.title).toMatch(/off/i);
    expect(copy.message).toContain("Support replies");
    expect(copy.consequence.length).toBeGreaterThan(20);
  });

  it("names an unnamed rule honestly", () => {
    expect(disableConfirmCopy({ ...route, name: "" }).message).toMatch(
      /^This rule/,
    );
  });

  it("verbs point in the right direction", () => {
    expect(toggleVerb(true).label).toMatch(/off/i);
    expect(toggleVerb(false).label).toMatch(/on$/i);
  });

  it("the offline refusal is copy a screen can show verbatim", () => {
    const err = new InboundRouteOfflineError();
    expect(err.code).toBe("offline_write_refused");
    expect(err.message).toMatch(/connected/i);
  });
});
