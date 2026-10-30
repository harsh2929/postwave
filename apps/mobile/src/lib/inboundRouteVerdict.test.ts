import { describe, expect, it } from "vitest";

import {
  disabledNotice,
  emptyRunsNotice,
  matchWindowNotice,
  routingPosture,
  routingVerdict,
  runOutcome,
} from "@/lib/inboundRouteVerdict";
import {
  actionRunStatusOf,
  normalizeInboundActionRuns,
  normalizeInboundMatches,
  normalizeInboundRoutes,
  type InboundRoute,
} from "@/lib/inboundRoutes";

/**
 * These tests pin the five server facts named at the top of
 * lib/inboundRoutes.ts. Each one is a place where the obvious implementation
 * states something the API cannot support.
 */

function routeWire(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    name: "Support replies",
    priority: 100,
    stop_on_match: true,
    enabled: true,
    match_recipient: "support@*",
    match_subject_prefix: "",
    match_from_domain: "",
    actions: [{ kind: "webhook", url: "https://example.test/hook" }],
    last_matched_at: "2026-07-25T03:00:00Z",
    match_count: 120,
    action_retry_max: 3,
    ...over,
  };
}

function route(over: Record<string, unknown> = {}): InboundRoute {
  const [first] = normalizeInboundRoutes({ routes: [routeWire(over)] });
  if (!first) throw new Error("fixture did not normalize");
  return first;
}

describe("normalizeInboundRoutes", () => {
  it("reads the envelope the handler actually writes", () => {
    const routes = normalizeInboundRoutes({ routes: [routeWire()] });
    expect(routes).toHaveLength(1);
    expect(routes[0]?.matchCount).toBe(120);
    expect(routes[0]?.actions[0]?.kind).toBe("webhook");
  });

  it("drops a row with no id rather than rendering an unopenable rule", () => {
    expect(normalizeInboundRoutes({ routes: [routeWire({ id: "" })] })).toEqual([]);
  });

  it("treats a missing enabled flag as disabled, which fails closed", () => {
    expect(route({ enabled: undefined }).enabled).toBe(false);
  });

  it("survives a payload that is not an object at all", () => {
    expect(normalizeInboundRoutes(null)).toEqual([]);
    expect(normalizeInboundMatches(undefined)).toEqual([]);
    expect(normalizeInboundActionRuns("nope")).toEqual([]);
  });
});

describe("normalizeInboundActionRuns", () => {
  it("keeps a null http_status as null — three action kinds never make a request", () => {
    const runs = normalizeInboundActionRuns({
      runs: [
        { id: 1, action_index: 0, action_kind: "tag", status: "succeeded", attempts: 1 },
        {
          id: 2,
          action_index: 1,
          action_kind: "webhook",
          status: "failed",
          attempts: 4,
          http_status: 503,
          error_message: "upstream refused",
        },
      ],
    });
    expect(runs[0]?.httpStatus).toBeNull();
    expect(runs[1]?.httpStatus).toBe(503);
  });

  it("does not re-label a status the CHECK constraint might gain later", () => {
    expect(actionRunStatusOf("succeeded")).toBe("succeeded");
    expect(actionRunStatusOf("FAILED")).toBe("failed");
    expect(actionRunStatusOf("quarantined")).toBe("unknown");
    expect(actionRunStatusOf("")).toBe("unknown");
  });
});

describe("routingPosture", () => {
  it("counts the two states that actually mislead a reader", () => {
    const routes = normalizeInboundRoutes({
      routes: [
        routeWire({ id: "a", enabled: true, match_count: 5 }),
        routeWire({ id: "b", enabled: true, match_count: 0 }),
        routeWire({ id: "c", enabled: false, match_count: 900 }),
        routeWire({ id: "d", enabled: false, match_count: 0 }),
      ],
    });
    expect(routingPosture(routes)).toEqual({
      total: 4,
      enabled: 2,
      disabled: 2,
      enabledNeverMatched: 1,
      disabledWithHistory: 1,
    });
  });
});

describe("routingVerdict", () => {
  it("never claims mail is routing fine — the API has no global match feed", () => {
    const routes = normalizeInboundRoutes({
      routes: [routeWire({ id: "a", enabled: true, match_count: 5 })],
    });
    const verdict = routingVerdict(routes);
    expect(verdict.tone).toBe("ok");
    expect(verdict.headline).toContain("matched at least once");
    expect(verdict.detail).toContain("Open a rule");
  });

  it("warns when every rule is switched off", () => {
    const routes = normalizeInboundRoutes({
      routes: [routeWire({ enabled: false })],
    });
    expect(routingVerdict(routes).tone).toBe("warn");
    expect(routingVerdict(routes).headline).toBe("All 1 rules are switched off");
  });

  it("warns about live rules that have never fired", () => {
    const routes = normalizeInboundRoutes({
      routes: [
        routeWire({ id: "a", match_count: 3 }),
        routeWire({ id: "b", match_count: 0 }),
      ],
    });
    expect(routingVerdict(routes).headline).toBe(
      "1 of 2 live rules have never matched",
    );
  });

  it("distinguishes 'no rules' from 'not read yet'", () => {
    expect(routingVerdict([]).headline).toBe("No routing rules");
    expect(routingVerdict(null).headline).toBe("No reading yet");
  });
});

describe("matchWindowNotice", () => {
  const PAGE = 50;

  it("separates a pruned history from a rule that never matched", () => {
    expect(matchWindowNotice(route({ match_count: 0 }), [], PAGE)).toBe(
      "This rule has never matched a message.",
    );
    expect(matchWindowNotice(route({ match_count: 120 }), [], PAGE)).toContain(
      "pruned on a retention schedule",
    );
  });

  it("says 'newest N of M' when the page is full and the counter is higher", () => {
    const matches = normalizeInboundMatches({
      matches: Array.from({ length: PAGE }, (_, i) => ({
        id: i + 1,
        route_id: "r1",
        recipient: "support@example.test",
        subject: "Re: hello",
        from_email: "a@b.test",
        matched_at: "2026-07-25T03:00:00Z",
      })),
    });
    expect(matchWindowNotice(route(), matches, PAGE)).toBe(
      "Showing the newest 50 of 120 lifetime matches.",
    );
  });

  it("states both figures when the page is not full", () => {
    const matches = normalizeInboundMatches({
      matches: [{ id: 1, route_id: "r1", matched_at: "2026-07-25T03:00:00Z" }],
    });
    expect(matchWindowNotice(route({ match_count: 4 }), matches, PAGE)).toBe(
      "1 recent match of 4 lifetime.",
    );
  });
});

describe("disabledNotice", () => {
  it("says nothing for a live rule", () => {
    expect(disabledNotice(route())).toBeNull();
  });

  it("is loud when a disabled rule still shows history", () => {
    const notice = disabledNotice(route({ enabled: false, match_count: 900 }));
    expect(notice).toContain("none of it is current behaviour");
  });

  it("is brief when a disabled rule has no history to mislead with", () => {
    expect(disabledNotice(route({ enabled: false, match_count: 0 }))).toBe(
      "This rule is switched off, so it matches nothing.",
    );
  });
});

describe("runOutcome", () => {
  it("counts retries even on runs that eventually succeeded", () => {
    const runs = normalizeInboundActionRuns({
      runs: [
        { id: 1, status: "succeeded", attempts: 3, action_kind: "webhook" },
        { id: 2, status: "failed", attempts: 4, action_kind: "webhook" },
        { id: 3, status: "skipped", attempts: 1, action_kind: "tag" },
        { id: 4, status: "weird", attempts: 1, action_kind: "tag" },
      ],
    });
    expect(runOutcome(runs)).toEqual({
      succeeded: 1,
      failed: 1,
      skipped: 1,
      unknown: 1,
      retried: 2,
    });
  });
});

describe("emptyRunsNotice", () => {
  it("says nothing when there are runs to render", () => {
    const runs = normalizeInboundActionRuns({ runs: [{ id: 1, status: "succeeded" }] });
    expect(emptyRunsNotice(route(), runs)).toBeNull();
  });

  it("explains an action-less rule rather than implying a failure", () => {
    expect(emptyRunsNotice(route({ actions: [] }), [])).toContain(
      "nothing to have failed",
    );
  });

  it("refuses to pick between the two causes of a missing run log", () => {
    expect(emptyRunsNotice(route(), [])).toContain("cannot tell the two apart");
  });
});
