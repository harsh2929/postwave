/**
 * The rules the audit-assistant surface must not get wrong, pinned against the
 * shapes apps/api actually emits (handlers/audit_nlq.go + audit/nlq.go).
 *
 * Three of these are load-bearing and were the reason the feature was deferred
 * rather than half-shipped:
 *
 *  1. WHO MAY ASK. `POST /api/v1/audit/nlq` is mounted behind
 *     `RequireScope(ScopeAuditRead)` but routeauth's manifest row is STRICTER
 *     (`session_minimum_role: admin`, `api_key_scopes: audit:execute_actions`),
 *     and the stricter of the two binds. A viewer offered the control could
 *     only ever receive a 403.
 *  2. UNKNOWN IS NOT DENIED. While the scope probe is in flight the surface
 *     must render neither the control nor a denial.
 *  3. ABSENCE IS NOT ZERO. A missing `total_count` is an em-dash, and a cap of
 *     0 means "no cap" — never "no budget left".
 */
import { describe, expect, it } from "vitest";

import {
  auditNlqAccess,
  auditNlqBudgetExhausted,
  auditNlqBudgetSentence,
  auditNlqErrorMessage,
  auditNlqResultSentence,
  describeAuditNlqFilters,
  parseAuditNlqAnswer,
  parseAuditNlqAvailability,
  parseAuditNlqBudget,
  parseAuditNlqFilters,
} from "./auditNlq";
import { auditExecuteFloorMet, savedViewWriteAccess } from "./auditSavedViewPolicy";

/** A response body shaped exactly like `nlqResponse` marshals. */
const WIRE = {
  query_preview: "who deleted subscribers yesterday?",
  structured_filters: {
    action: "delete",
    resource_type: "subscriber",
    since: "2026-08-01T00:00:00Z",
    limit: 50,
  },
  invalid_fields: ["colour"],
  results: [
    {
      id: 42,
      action: "subscriber.delete",
      actorType: "user",
      actorLabel: "ada@example.com",
      metadata: {},
      at: "2026-08-01T09:00:00Z",
    },
  ],
  total_count: 137,
  summary: "One deletion, by Ada.",
  trace: {
    reasoning: "Mapped 'deleted' to action delete.",
    model: "claude-x",
    raw_llm_response: "{}",
    prompt_tokens: 100,
    response_tokens: 20,
    summary_tokens: 5,
    cache_hit: false,
    retention_days: 90,
    generated_at: "2026-08-02T00:00:00Z",
  },
  cost_status: {
    daily_usage_tokens: 125,
    daily_cap_tokens: 10_000,
    remaining_tokens: 9_875,
    reset_at: "2026-08-03T00:00:00Z",
  },
};

describe("parsing the wire", () => {
  it("reads the whole answer, keeping total_count distinct from row count", () => {
    const answer = parseAuditNlqAnswer(WIRE);
    expect(answer.question).toBe("who deleted subscribers yesterday?");
    expect(answer.rows).toHaveLength(1);
    // The row limit capped what came back; the denominator is the COUNT(*).
    expect(answer.totalCount).toBe(137);
    expect(answer.invalidFields).toEqual(["colour"]);
    expect(answer.filters.action).toBe("delete");
    expect(answer.filters.resourceType).toBe("subscriber");
    expect(answer.trace.totalTokens).toBe(125);
    expect(answer.budget.remainingTokens).toBe(9_875);
  });

  it("survives an empty / malformed body without inventing measurements", () => {
    const answer = parseAuditNlqAnswer(null);
    expect(answer.rows).toEqual([]);
    expect(answer.totalCount).toBeNull();
    expect(answer.trace.totalTokens).toBeNull();
    expect(answer.budget.capTokens).toBeNull();
    expect(answer.invalidFields).toEqual([]);
  });

  it("treats a Go zero-value filter string as absence, not as a filter", () => {
    // `omitempty` means the server drops empty fields, but a hand-rolled proxy
    // or an older build can still emit "". "" must not render as a facet.
    const filters = parseAuditNlqFilters({ actor_type: "", action: "login" });
    expect(filters.actorType).toBeNull();
    expect(filters.action).toBe("login");
    expect(describeAuditNlqFilters(filters)).toEqual([
      { label: "Action contains", value: "login" },
    ]);
  });

  it("reads nlq_available, and answers null when the field is absent", () => {
    expect(parseAuditNlqAvailability({ nlq_available: false })).toBe(false);
    expect(parseAuditNlqAvailability({ nlq_available: true })).toBe(true);
    // An older gateway that omits it is UNKNOWN — not a claim of absence.
    expect(parseAuditNlqAvailability({ daily_cap_tokens: 1 })).toBeNull();
  });
});

describe("the budget, where zero has two meanings", () => {
  it("says nothing when the cap is 0 — DailyCostTracker calls that unlimited", () => {
    const budget = parseAuditNlqBudget({
      daily_usage_tokens: 10,
      daily_cap_tokens: 0,
      remaining_tokens: 0,
    });
    expect(auditNlqBudgetSentence(budget)).toBeNull();
    expect(auditNlqBudgetExhausted(budget)).toBe(false);
  });

  it("only calls the budget spent when a real cap has run out", () => {
    const budget = parseAuditNlqBudget({
      daily_cap_tokens: 100,
      remaining_tokens: 0,
    });
    expect(auditNlqBudgetExhausted(budget)).toBe(true);
    expect(auditNlqBudgetSentence(budget)).toContain("resets at midnight UTC");
  });

  it("renders the remaining figure when there is one", () => {
    expect(
      auditNlqBudgetSentence(
        parseAuditNlqBudget({ daily_cap_tokens: 10_000, remaining_tokens: 9_875 }),
      ),
    ).toContain("9,875");
  });
});

describe("result counts", () => {
  it("distinguishes 'no rows returned' from 'nothing matched'", () => {
    expect(auditNlqResultSentence(0, 0)).toBe("No events matched this translation.");
    expect(auditNlqResultSentence(0, 12)).toBe("No events returned (12 matched).");
  });

  it("renders an unknown total as an em-dash rather than as zero", () => {
    expect(auditNlqResultSentence(3, null)).toBe("Showing 3 of — matching events.");
  });

  it("does not claim a truncation that did not happen", () => {
    expect(auditNlqResultSentence(3, 3)).toBe("3 events matched.");
    expect(auditNlqResultSentence(1, 1)).toBe("1 event matched.");
    expect(auditNlqResultSentence(50, 137)).toBe("Showing 50 of 137 matching events.");
  });
});

describe("who may ask", () => {
  const admin = { scopes: [], auditScopes: ["audit:read"], isAdmin: true };
  const editor = { scopes: [], auditScopes: ["audit:read"], isAdmin: false };
  const keyWithExecute = {
    scopes: ["audit:execute_actions"],
    auditScopes: [],
    isAdmin: false,
  };

  it("withholds BOTH control and denial while the scope probe is unanswered", () => {
    const access = auditNlqAccess({
      floorMet: auditExecuteFloorMet({ scopes: undefined, mode: "session" }),
      mode: "session",
      available: null,
    });
    expect(access).toEqual({ allowed: false, known: false, notice: null });
  });

  it("refuses an editor holding audit:read — routeauth's floor is admin", () => {
    const access = auditNlqAccess({
      floorMet: auditExecuteFloorMet({ scopes: editor, mode: "session" }),
      mode: "session",
      available: true,
    });
    expect(access.allowed).toBe(false);
    expect(access.known).toBe(true);
    expect(access.notice).toContain("owners and admins");
  });

  it("allows an admin session once the server says the pipeline exists", () => {
    expect(
      auditNlqAccess({
        floorMet: auditExecuteFloorMet({ scopes: admin, mode: "session" }),
        mode: "session",
        available: true,
      }),
    ).toEqual({ allowed: true, known: true, notice: null });
  });

  it("does not deny on an unknown availability — only on an explicit false", () => {
    expect(
      auditNlqAccess({
        floorMet: true,
        mode: "session",
        available: null,
      }).allowed,
    ).toBe(true);
    const off = auditNlqAccess({ floorMet: true, mode: "session", available: false });
    expect(off.allowed).toBe(false);
    expect(off.notice).toContain("not configured");
  });

  it("judges an API key by its scope, never by the session role rank", () => {
    // `apikeys.HasScope` treats `admin` as a wildcard, and routeauth checks
    // api_key_scopes with mode `any` — applying the session's admin-role test
    // to a key would refuse one the server would have accepted.
    expect(auditExecuteFloorMet({ scopes: keyWithExecute, mode: "api_key" })).toBe(true);
    expect(auditExecuteFloorMet({ scopes: editor, mode: "api_key" })).toBe(false);
    expect(
      auditNlqAccess({ floorMet: false, mode: "api_key", available: true }).notice,
    ).toContain("audit:execute_actions");
  });

  it("keeps the saved-view policy on the same floor it always had", () => {
    // The shared predicate is a refactor, not a policy change: these are the
    // answers savedViewWriteAccess gave before it existed.
    expect(savedViewWriteAccess({ scopes: undefined, mode: "session" })).toEqual({
      allowed: false,
      known: false,
      notice: null,
    });
    expect(savedViewWriteAccess({ scopes: admin, mode: "session" }).allowed).toBe(true);
    expect(savedViewWriteAccess({ scopes: editor, mode: "session" }).allowed).toBe(false);
    expect(
      savedViewWriteAccess({ scopes: keyWithExecute, mode: "api_key" }).allowed,
    ).toBe(true);
  });
});

describe("failure copy", () => {
  it("maps every code the handler and TranslateLLMError can produce", () => {
    expect(auditNlqErrorMessage(503, "nlq_unavailable", "")).toContain(
      "not switched on",
    );
    expect(auditNlqErrorMessage(503, "nlq_llm_auth", "")).toContain("credentials");
    expect(auditNlqErrorMessage(429, "cost_cap_exceeded", "")).toContain("budget");
    expect(auditNlqErrorMessage(429, "nlq_llm_rate_limited", "")).toContain(
      "rate-limited",
    );
    expect(auditNlqErrorMessage(502, "nlq_bad_translation", "")).toContain(
      "rephrasing",
    );
    expect(auditNlqErrorMessage(504, "nlq_timeout", "")).toContain("too long");
    expect(auditNlqErrorMessage(400, "query_too_long", "")).toContain("2,000");
    expect(auditNlqErrorMessage(403, undefined, "")).toContain("permission");
  });

  it("prefers a readable server sentence over generic copy, but not a token", () => {
    expect(auditNlqErrorMessage(500, undefined, "the log is being compacted")).toBe(
      "the log is being compacted",
    );
    expect(auditNlqErrorMessage(500, undefined, "ECONNRESET")).toContain(
      "Try again in a moment",
    );
  });
});
