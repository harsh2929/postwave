import { describe, expect, it } from "vitest";

import {
  AUDIT_ALERT_DORMANT_AFTER_DAYS,
  AUDIT_ALERT_SILENT_AFTER_DAYS,
  auditAlertCounts,
  auditAlertErrorMessage,
  auditAlertReadCaveat,
  auditAlertToggleAccess,
  orderAuditAlertRules,
  ruleAttention,
  toggleCopy,
  toggleSuccessMessage,
  type AuditAlertScopeSet,
} from "./auditAlertPolicy";
import { parseAuditAlertRule, type AuditAlertRule } from "./auditAlertRules";

/** A wire row shaped exactly like `Deps.List` writes it. */
function wireRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "9d2b7f6e-0000-4000-8000-000000000001",
    name: "Subscriber exports",
    enabled: true,
    action_glob: "subscribers.export*",
    operator_kind: "glob",
    operator_config: {},
    channel_kind: "email",
    channel_config: { to: "soc@example.test" },
    notify_slack: false,
    fired_count: 12,
    last_fired_at: "2026-07-20T09:00:00Z",
    last_error: "",
    created_at: "2026-07-01T09:00:00Z",
    ...overrides,
  };
}

function rule(overrides: Partial<AuditAlertRule> = {}): AuditAlertRule {
  const parsed = parseAuditAlertRule(wireRule());
  if (!parsed) throw new Error("fixture failed to parse");
  return { ...parsed, ...overrides };
}

describe("list ordering puts the incident first", () => {
  it("sorts failing before active before paused", () => {
    const rows = [
      rule({ id: "paused", name: "C", enabled: false }),
      rule({ id: "active", name: "B", lastError: "" }),
      rule({ id: "failing", name: "A", lastError: "smtp: 550" }),
    ];
    expect(orderAuditAlertRules(rows).map((r) => r.id)).toEqual([
      "failing",
      "active",
      "paused",
    ]);
  });

  it("within a band prefers the most recent fire, and never-fired sorts last", () => {
    const rows = [
      rule({ id: "never", lastFiredAt: null, name: "zzz" }),
      rule({ id: "old", lastFiredAt: "2026-07-01T00:00:00Z" }),
      rule({ id: "new", lastFiredAt: "2026-07-20T00:00:00Z" }),
    ];
    expect(orderAuditAlertRules(rows).map((r) => r.id)).toEqual([
      "new",
      "old",
      "never",
    ]);
  });

  it("is stable and does not mutate its input", () => {
    const rows = [
      rule({ id: "b", name: "Beta", lastFiredAt: null }),
      rule({ id: "a", name: "Alpha", lastFiredAt: null }),
    ];
    const snapshot = rows.map((r) => r.id);
    expect(orderAuditAlertRules(rows).map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-25T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

describe("auditAlertCounts", () => {
  it("counts enabled, failing and quiet independently of each other", () => {
    expect(
      auditAlertCounts(
        [
          rule({ enabled: true, lastError: "" }),
          rule({ enabled: true, lastError: "boom" }),
          rule({ enabled: false, lastError: "boom" }),
          rule({
            enabled: true,
            lastError: "",
            lastFiredAt: null,
            createdAt: daysAgo(40),
          }),
        ],
        NOW,
      ),
    ).toEqual({ total: 4, enabled: 3, failing: 1, quiet: 1 });
    expect(auditAlertCounts([], NOW)).toEqual({
      total: 0,
      enabled: 0,
      failing: 0,
      quiet: 0,
    });
  });
});

describe("a rule nothing has matched", () => {
  it("flags a long-enabled rule that has never fired", () => {
    const note = ruleAttention(
      rule({
        lastFiredAt: null,
        createdAt: daysAgo(AUDIT_ALERT_SILENT_AFTER_DAYS + 1),
      }),
      NOW,
    );
    expect(note?.kind).toBe("never_fired");
    expect(note?.label).toBe("Never fired");
    expect(note?.spoken).toContain("15 days");
  });

  it("says nothing about a rule created yesterday", () => {
    expect(
      ruleAttention(rule({ lastFiredAt: null, createdAt: daysAgo(1) }), NOW),
    ).toBeNull();
  });

  it("refuses to date a silence it cannot date — absence is not zero", () => {
    // created_at absent from the payload: "never fired" without "for how long"
    // is not a claim worth making, so no note at all.
    expect(
      ruleAttention(rule({ lastFiredAt: null, createdAt: null }), NOW),
    ).toBeNull();
  });

  it("flags a rule that has gone quiet, in neutral terms", () => {
    const note = ruleAttention(
      rule({ lastFiredAt: daysAgo(AUDIT_ALERT_DORMANT_AFTER_DAYS + 5) }),
      NOW,
    );
    expect(note?.kind).toBe("dormant");
    expect(note?.tone).toBe("neutral");
    expect(note?.spoken).toContain("Quiet is not the same as broken");
  });

  it("stays silent for a rule that fired this week", () => {
    expect(ruleAttention(rule({ lastFiredAt: daysAgo(2) }), NOW)).toBeNull();
  });

  it("never competes with the louder stories: paused and failing own the row", () => {
    expect(
      ruleAttention(
        rule({ enabled: false, lastFiredAt: null, createdAt: daysAgo(90) }),
        NOW,
      ),
    ).toBeNull();
    expect(
      ruleAttention(
        rule({ lastError: "smtp: 550", lastFiredAt: daysAgo(90) }),
        NOW,
      ),
    ).toBeNull();
  });
});

function scopeSet(
  overrides: Partial<AuditAlertScopeSet> = {},
): AuditAlertScopeSet {
  return {
    scopes: ["audit:read", "audit:configure_sinks"],
    auditScopes: ["audit:read", "audit:configure_sinks"],
    isAdmin: true,
    ...overrides,
  };
}

describe("who may pause a rule", () => {
  it("renders no verdict at all until my-scopes answers", () => {
    const unknown = auditAlertToggleAccess({
      scopes: null,
      mode: "session",
      online: true,
    });
    expect(unknown).toEqual({ allowed: false, known: false, notice: null });
  });

  it("denies a non-admin session regardless of connectivity, and says why", () => {
    // routeauth's manifest row for PATCH is session_minimum_role "admin", and
    // roleAllows() is evaluated before the handler chain.
    const denied = auditAlertToggleAccess({
      scopes: scopeSet({ isAdmin: false, auditScopes: ["audit:read"] }),
      mode: "session",
      online: true,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.notice).toContain("owner or admin role");
    // Permission is checked BEFORE connectivity: reconnecting cannot grant it.
    expect(
      auditAlertToggleAccess({
        scopes: scopeSet({ isAdmin: false, auditScopes: ["audit:read"] }),
        mode: "session",
        online: false,
      }).notice,
    ).toContain("owner or admin role");
  });

  it("denies an admin whose role was stripped of audit:configure_sinks", () => {
    // A tenant that edited the admin role's roles_permissions row leaves the
    // handler's RequireScope(ScopeAuditConfigureSinks) unsatisfied even though
    // routeauth's role floor passes.
    const denied = auditAlertToggleAccess({
      scopes: scopeSet({
        auditScopes: ["audit:read"],
        scopes: ["audit:read"],
      }),
      mode: "session",
      online: true,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.notice).toContain("audit:configure_sinks");
  });

  it("asks an API key for the admin scope, not for audit:configure_sinks", () => {
    // routeauth's api_key_scopes for PATCH is ["admin"], so the audit scope on
    // its own is refused by the router before the handler ever runs.
    const denied = auditAlertToggleAccess({
      scopes: scopeSet({ isAdmin: false }),
      mode: "api_key",
      online: true,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.notice).toContain("admin scope");

    // …and an admin key needs no second scope: `admin` is a HasScope wildcard.
    expect(
      auditAlertToggleAccess({
        scopes: { scopes: ["admin"], auditScopes: [], isAdmin: true },
        mode: "api_key",
        online: true,
      }).allowed,
    ).toBe(true);
  });

  it("denies an offline admin and explains that nothing is queued", () => {
    const offline = auditAlertToggleAccess({
      scopes: scopeSet(),
      mode: "session",
      online: false,
    });
    expect(offline.allowed).toBe(false);
    expect(offline.notice).toContain("never queued");
  });

  it("allows an online admin with the scope, and says nothing", () => {
    expect(
      auditAlertToggleAccess({
        scopes: scopeSet(),
        mode: "session",
        online: true,
      }),
    ).toEqual({ allowed: true, known: true, notice: null });
  });
});

describe("the API-key-only read caveat", () => {
  it("warns a key that routeauth will refuse for want of read:reports", () => {
    const caveat = auditAlertReadCaveat({
      scopes: scopeSet({
        isAdmin: false,
        scopes: ["audit:read"],
        auditScopes: ["audit:read"],
      }),
      mode: "api_key",
    });
    expect(caveat).toContain("read:reports");
  });

  it("says nothing to a session, whose manifest floor is viewer", () => {
    expect(
      auditAlertReadCaveat({
        scopes: scopeSet({ isAdmin: false, scopes: [], auditScopes: ["audit:read"] }),
        mode: "session",
      }),
    ).toBeNull();
  });

  it("says nothing to a key that holds read:reports, or the admin wildcard", () => {
    expect(
      auditAlertReadCaveat({
        scopes: scopeSet({
          isAdmin: false,
          scopes: ["audit:read", "read:reports"],
        }),
        mode: "api_key",
      }),
    ).toBeNull();
    expect(
      auditAlertReadCaveat({
        scopes: { scopes: ["admin"], auditScopes: [], isAdmin: true },
        mode: "api_key",
      }),
    ).toBeNull();
  });

  it("says nothing before the scope answer arrives", () => {
    expect(
      auditAlertReadCaveat({ scopes: undefined, mode: "api_key" }),
    ).toBeNull();
  });
});

describe("toggle copy", () => {
  it("treats pausing as the destructive direction", () => {
    const pause = toggleCopy(rule({ enabled: true }));
    expect(pause.destructive).toBe(true);
    expect(pause.confirmLabel).toBe("Pause");
    expect(pause.title).toContain("Subscriber exports");
    expect(pause.consequence).toContain("subscribers.export*");
  });

  it("warns that resuming can deliver a burst", () => {
    const resume = toggleCopy(rule({ enabled: false }));
    expect(resume.destructive).toBe(false);
    expect(resume.confirmLabel).toBe("Resume");
    expect(resume.message).toContain("burst");
    expect(resume.consequence).toContain("Email");
  });

  it("reports the outcome in the rule's own name", () => {
    expect(toggleSuccessMessage(rule(), false)).toBe(
      "Paused “Subscriber exports”. It is no longer watching.",
    );
    expect(toggleSuccessMessage(rule(), true)).toBe("Resumed “Subscriber exports”.");
  });
});

describe("failure copy", () => {
  it("maps the statuses this endpoint actually returns", () => {
    expect(auditAlertErrorMessage({ status: 403 })).toContain("role no longer allows");
    expect(auditAlertErrorMessage({ status: 404 })).toContain("no longer exists");
    expect(auditAlertErrorMessage({ status: 401 })).toContain("session expired");
    // status 0 is the transport failure the mobile envelope reports.
    expect(auditAlertErrorMessage({ status: 0 })).toContain("didn't reach the server");
  });

  it("falls back to the error's own message, then to a generic line", () => {
    expect(auditAlertErrorMessage(Object.assign(new Error("rule_locked"), { status: 409 }))).toBe(
      "rule_locked",
    );
    expect(auditAlertErrorMessage({ status: 500 })).toBe("Please try again.");
    expect(auditAlertErrorMessage(undefined)).toContain("didn't reach the server");
  });
});
