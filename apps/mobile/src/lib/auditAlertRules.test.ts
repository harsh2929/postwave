import { describe, expect, it } from "vitest";

import {
  auditAlertCount,
  auditAlertTimestamp,
  channelDestination,
  channelLabel,
  healthPresentation,
  httpsHost,
  matchNarrowing,
  operatorSummary,
  parseAuditAlertFireList,
  parseAuditAlertRule,
  parseAuditAlertRuleList,
  ruleHealth,
  type AuditAlertRule,
} from "./auditAlertRules";

/** A wire row shaped exactly like `Deps.List` writes it. */
function wireRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "9d2b7f6e-0000-4000-8000-000000000001",
    name: "Subscriber exports",
    enabled: true,
    action_glob: "subscribers.export*",
    actor_type: "",
    actor_label_glob: "",
    resource_type: "",
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

describe("parsing the audit-alert wire shapes", () => {
  it("reads the list out of the server's {rules:[…]} envelope", () => {
    const rows = parseAuditAlertRuleList({ rules: [wireRule()] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Subscriber exports");
    expect(rows[0]?.channelKind).toBe("email");
    expect(rows[0]?.firedCount).toBe(12);
  });

  it("also accepts a bare array, so an envelope change cannot empty the screen", () => {
    expect(parseAuditAlertRuleList([wireRule()])).toHaveLength(1);
  });

  it("returns an empty list — not a crash — for junk", () => {
    expect(parseAuditAlertRuleList(null)).toEqual([]);
    expect(parseAuditAlertRuleList({ rules: "nope" })).toEqual([]);
    expect(parseAuditAlertRuleList({ items: [wireRule()] })).toEqual([]);
  });

  it("drops rows with no id rather than rendering a keyless row", () => {
    expect(parseAuditAlertRule({ name: "x" })).toBeNull();
    expect(parseAuditAlertRuleList({ rules: [{ name: "x" }, wireRule()] })).toHaveLength(1);
  });

  it("never renders an empty rule title", () => {
    expect(parseAuditAlertRule(wireRule({ name: "   " }))?.name).toBe(
      "Untitled rule",
    );
  });

  it("treats a missing fired_count as absent, not as zero", () => {
    expect(auditAlertCount(undefined)).toBeNull();
    expect(auditAlertCount(null)).toBeNull();
    expect(auditAlertCount(-3)).toBeNull();
    expect(auditAlertCount(0)).toBe(0);
    expect(parseAuditAlertRule(wireRule({ fired_count: undefined }))?.firedCount).toBeNull();
    expect(parseAuditAlertRule(wireRule({ fired_count: 0 }))?.firedCount).toBe(0);
  });

  it("maps Go's zero time to null instead of the year 1", () => {
    expect(auditAlertTimestamp("0001-01-01T00:00:00Z")).toBeNull();
    expect(auditAlertTimestamp("not a date")).toBeNull();
    expect(auditAlertTimestamp("")).toBeNull();
    expect(auditAlertTimestamp("2026-07-20T09:00:00Z")).toBe(
      "2026-07-20T09:00:00Z",
    );
  });

  it("only trusts an explicit boolean for enabled / notify_slack", () => {
    expect(parseAuditAlertRule(wireRule({ enabled: "true" }))?.enabled).toBe(false);
    expect(parseAuditAlertRule(wireRule({ notify_slack: 1 }))?.notifySlack).toBe(false);
    expect(parseAuditAlertRule(wireRule({ notify_slack: true }))?.notifySlack).toBe(true);
  });

  it("reads fires out of the server's {fires:[…]} envelope", () => {
    const fires = parseAuditAlertFireList({
      fires: [
        {
          id: 4,
          audit_id: 990,
          delivered: false,
          delivery_error: "smtp: 550",
          fired_at: "2026-07-20T09:00:00Z",
        },
      ],
    });
    expect(fires).toEqual([
      {
        id: 4,
        auditId: 990,
        delivered: false,
        deliveryError: "smtp: 550",
        firedAt: "2026-07-20T09:00:00Z",
      },
    ]);
  });

  it("drops a fire with no id and tolerates a bare array", () => {
    expect(parseAuditAlertFireList({ fires: [{ delivered: true }] })).toEqual([]);
    expect(parseAuditAlertFireList([{ id: 1 }])).toHaveLength(1);
    expect(parseAuditAlertFireList(undefined)).toEqual([]);
  });
});

describe("rule health is three states, not a boolean", () => {
  it("separates 'enabled and failing' from 'enabled'", () => {
    expect(ruleHealth(rule({ enabled: true, lastError: "" }))).toBe("active");
    expect(ruleHealth(rule({ enabled: true, lastError: "smtp: 550" }))).toBe(
      "failing",
    );
    expect(ruleHealth(rule({ enabled: false, lastError: "smtp: 550" }))).toBe(
      "paused",
    );
  });

  it("carries a WORD for every state, so nothing is colour-alone", () => {
    for (const health of ["failing", "active", "paused"] as const) {
      const presentation = healthPresentation(health);
      expect(presentation.label.length).toBeGreaterThan(0);
      // The spoken form must say more than the compacted pill, since the pill
      // is exactly what a screen-reader user cannot recover.
      expect(presentation.spoken.length).toBeGreaterThan(
        presentation.label.length,
      );
    }
    expect(healthPresentation("failing").tone).toBe("danger");
    expect(healthPresentation("active").label).toBe("Enabled");
    expect(healthPresentation("paused").label).toBe("Paused");
  });
});

describe("the channel is described without leaking its credential", () => {
  it("names every kind the server accepts, and unknown kinds verbatim", () => {
    expect(channelLabel("email")).toBe("Email");
    expect(channelLabel("slack")).toBe("Slack webhook");
    expect(channelLabel("webhook")).toBe("Webhook");
    expect(channelLabel("servicenow")).toBe("ServiceNow");
    expect(channelLabel("jira")).toBe("Jira");
    expect(channelLabel("pagerduty")).toBe("PagerDuty");
    expect(channelLabel("carrier-pigeon")).toBe("carrier-pigeon");
    expect(channelLabel("  ")).toBe("No channel");
  });

  it("shows the email destination, which is not a secret", () => {
    expect(
      channelDestination(
        rule({ channelKind: "email", channelConfig: { to: "soc@example.test" } }),
      ),
    ).toBe("soc@example.test");
  });

  it("NEVER returns a Slack webhook URL or a PagerDuty routing key", () => {
    const slack = rule({
      channelKind: "slack",
      channelConfig: { webhook_url: "https://hooks.slack.com/services/T/B/xoxb-SECRET" },
    });
    expect(channelDestination(slack)).toBeNull();

    const pagerduty = rule({
      channelKind: "pagerduty",
      channelConfig: { routing_key: "R0UT1NGK3Y" },
    });
    expect(channelDestination(pagerduty)).toBeNull();
  });

  it("reduces URL-shaped integrations to their host, dropping any secret path", () => {
    expect(
      channelDestination(
        rule({
          channelKind: "webhook",
          channelConfig: { url: "https://soc.example.test/hooks/abc-SECRET?token=xyz" },
        }),
      ),
    ).toBe("soc.example.test");
    expect(
      channelDestination(
        rule({
          channelKind: "servicenow",
          channelConfig: {
            instance_url: "https://acme.service-now.com/api",
            bearer_token: "SECRET",
          },
        }),
      ),
    ).toBe("acme.service-now.com");
    expect(
      channelDestination(
        rule({
          channelKind: "jira",
          channelConfig: {
            site_url: "https://acme.atlassian.net",
            project_key: "SEC",
            email: "a@b.test",
            api_token: "SECRET",
          },
        }),
      ),
    ).toBe("acme.atlassian.net · SEC");
  });

  it("returns null rather than an empty string when nothing is safe to say", () => {
    expect(channelDestination(rule({ channelKind: "email", channelConfig: {} }))).toBeNull();
    expect(channelDestination(rule({ channelKind: "webhook", channelConfig: {} }))).toBeNull();
    expect(channelDestination(rule({ channelKind: "nonsense", channelConfig: { url: "https://x.test" } }))).toBeNull();
  });

  it("only accepts https hosts", () => {
    expect(httpsHost("https://a.test/x")).toBe("a.test");
    expect(httpsHost("http://a.test/x")).toBeNull();
    expect(httpsHost("javascript:alert(1)")).toBeNull();
    expect(httpsHost(42)).toBeNull();
  });

  it("does not put any credential-shaped field into the rendered destination", () => {
    const secrets = ["SECRET", "xoxb", "R0UT1NGK3Y", "hooks.slack.com"];
    const rules = [
      rule({ channelKind: "slack", channelConfig: { webhook_url: "https://hooks.slack.com/services/xoxb-SECRET" } }),
      rule({ channelKind: "pagerduty", channelConfig: { routing_key: "R0UT1NGK3Y" } }),
      rule({ channelKind: "jira", channelConfig: { site_url: "https://a.test", project_key: "P", api_token: "SECRET" } }),
      rule({ channelKind: "servicenow", channelConfig: { instance_url: "https://b.test", password: "SECRET" } }),
      rule({ channelKind: "webhook", channelConfig: { url: "https://c.test/SECRET" } }),
    ];
    for (const row of rules) {
      const rendered = channelDestination(row) ?? "";
      for (const secret of secrets) expect(rendered).not.toContain(secret);
    }
  });
});

describe("operatorSummary describes the rule in its own operator's terms", () => {
  it("renders a glob rule as a per-event match", () => {
    expect(operatorSummary(rule({ operatorKind: "glob" }))).toBe(
      "Every audit event matching subscribers.export*",
    );
    // The server defaults an empty operator_kind to glob at create time.
    expect(operatorSummary(rule({ operatorKind: "" }))).toContain("Every audit event");
  });

  it("renders a threshold window with its count, window and grouping", () => {
    expect(
      operatorSummary(
        rule({
          operatorKind: "threshold_window",
          actionGlob: "auth.login_failed",
          operatorConfig: { count: 5, window_min: 5, group_by: "actor_label" },
        }),
      ),
    ).toBe("5 events matching auth.login_failed by the same actor within 5 minutes");
    expect(
      operatorSummary(
        rule({
          operatorKind: "threshold_window",
          operatorConfig: { count: 1, window_min: 1 },
        }),
      ),
    ).toBe("1 event matching subscribers.export* within 1 minute");
  });

  it("calls an unfireable rule unfireable instead of rendering zeroes", () => {
    // evaluateOperator returns Fire:false for count<=0 / window<=0.
    expect(
      operatorSummary(
        rule({ operatorKind: "threshold_window", operatorConfig: { count: 0, window_min: 5 } }),
      ),
    ).toContain("can never fire");
    expect(
      operatorSummary(
        rule({ operatorKind: "rate_deviation", operatorConfig: { deviation_pct: 0 } }),
      ),
    ).toContain("can never fire");
    expect(
      operatorSummary(
        rule({ operatorKind: "outlier", operatorConfig: { kind: "teleportation" } }),
      ),
    ).toContain("can never fire");
    // Unknown operator kinds are conservatively dropped by the worker.
    expect(operatorSummary(rule({ operatorKind: "quantum" }))).toContain(
      "will not fire",
    );
  });

  it("renders rate deviation and the three named outlier detectors", () => {
    expect(
      operatorSummary(
        rule({
          operatorKind: "rate_deviation",
          operatorConfig: { deviation_pct: 250, baseline_days: 7 },
        }),
      ),
    ).toBe("subscribers.export* running 250% above its 7-days baseline");
    expect(
      operatorSummary(
        rule({ operatorKind: "outlier", operatorConfig: { kind: "impossible_travel" } }),
      ),
    ).toContain("Impossible travel");
    expect(
      operatorSummary(
        rule({ operatorKind: "outlier", operatorConfig: { kind: "escalation_chain" } }),
      ),
    ).toContain("Privilege-escalation chain");
    expect(
      operatorSummary(
        rule({ operatorKind: "outlier", operatorConfig: { kind: "off_hours" } }),
      ),
    ).toContain("Out-of-hours activity");
  });
});

describe("matchNarrowing", () => {
  it("is null when the rule has no extra criteria", () => {
    expect(matchNarrowing(rule())).toBeNull();
  });

  it("joins every AND-ed criterion the server supports", () => {
    expect(
      matchNarrowing(
        rule({ actorType: "api_key", actorLabelGlob: "ci-*", resourceType: "subscriber" }),
      ),
    ).toBe("actor type api_key · actor ci-* · resource subscriber");
  });
});
