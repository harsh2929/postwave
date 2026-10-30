/**
 * lib/auditAlertCreate — the client-side mirror of the Go create validators.
 *
 * Fixtures here are the SERVER's refusal cases, restated: every `expect` on an
 * error corresponds to a 400 branch in validateChannelConfig /
 * validateOperatorConfig (audit_alerts.go). If the server contract moves,
 * these tests are the file to move with it.
 */
import { describe, expect, it } from "vitest";

import {
  AUDIT_ALERT_CHANNEL_FIELDS,
  buildAuditAlertCreateBody,
  emptyAuditAlertDraft,
  validateAuditAlertDraft,
  type AuditAlertDraft,
} from "./auditAlertCreate";

function draft(over: Partial<AuditAlertDraft> = {}): AuditAlertDraft {
  return {
    ...emptyAuditAlertDraft(),
    name: "Subscriber exports",
    actionGlob: "subscribers.export*",
    channelKind: "email",
    channel: { to: "soc@example.com" },
    ...over,
  };
}

describe("required base fields", () => {
  it("refuses a blank name or action glob", () => {
    expect(validateAuditAlertDraft(draft({ name: "  " }))).toContain(
      "Name the rule.",
    );
    expect(
      validateAuditAlertDraft(draft({ actionGlob: "" })).some((e) =>
        e.includes("which actions"),
      ),
    ).toBe(true);
  });

  it("accepts the minimal valid email rule", () => {
    expect(validateAuditAlertDraft(draft())).toEqual([]);
  });
});

describe("channel validators mirror the server", () => {
  it("slack: only a hooks.slack.com URL passes", () => {
    const bad = draft({
      channelKind: "slack",
      channel: { webhook_url: "https://evil.example/hook" },
    });
    expect(validateAuditAlertDraft(bad).length).toBe(1);
    const good = draft({
      channelKind: "slack",
      channel: { webhook_url: "https://hooks.slack.com/services/T/B/x" },
    });
    expect(validateAuditAlertDraft(good)).toEqual([]);
  });

  it("webhook: must be https", () => {
    expect(
      validateAuditAlertDraft(
        draft({ channelKind: "webhook", channel: { url: "http://x" } }),
      ).length,
    ).toBe(1);
  });

  it("servicenow: bearer OR username+password, plus an https instance", () => {
    const base = { instance_url: "https://acme.service-now.com" };
    expect(
      validateAuditAlertDraft(
        draft({ channelKind: "servicenow", channel: { ...base } }),
      ).length,
    ).toBe(1);
    expect(
      validateAuditAlertDraft(
        draft({
          channelKind: "servicenow",
          channel: { ...base, bearer_token: "t" },
        }),
      ),
    ).toEqual([]);
    expect(
      validateAuditAlertDraft(
        draft({
          channelKind: "servicenow",
          channel: { ...base, username: "u", password: "p" },
        }),
      ),
    ).toEqual([]);
    // Half the pair is not a credential.
    expect(
      validateAuditAlertDraft(
        draft({
          channelKind: "servicenow",
          channel: { ...base, username: "u" },
        }),
      ).length,
    ).toBe(1);
  });

  it("jira: https site, project key, email + api token", () => {
    const errors = validateAuditAlertDraft(
      draft({ channelKind: "jira", channel: { site_url: "https://a.atlassian.net" } }),
    );
    expect(errors.some((e) => e.includes("project key"))).toBe(true);
    expect(errors.some((e) => e.includes("API token"))).toBe(true);
    expect(
      validateAuditAlertDraft(
        draft({
          channelKind: "jira",
          channel: {
            site_url: "https://a.atlassian.net",
            project_key: "SEC",
            email: "bot@example.com",
            api_token: "tok",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("pagerduty: needs a routing key", () => {
    expect(
      validateAuditAlertDraft(
        draft({ channelKind: "pagerduty", channel: {} }),
      ).length,
    ).toBe(1);
  });
});

describe("operator validators mirror the server", () => {
  it("threshold_window: count > 0 and window in (0, 1440]", () => {
    const bad = draft({
      operatorKind: "threshold_window",
      thresholdCount: "0",
      windowMin: "1441",
    });
    const errors = validateAuditAlertDraft(bad);
    expect(errors.some((e) => e.includes("count"))).toBe(true);
    expect(errors.some((e) => e.includes("1440"))).toBe(true);
    expect(
      validateAuditAlertDraft(
        draft({
          operatorKind: "threshold_window",
          thresholdCount: "5",
          windowMin: "5",
        }),
      ),
    ).toEqual([]);
  });

  it("rate_deviation: deviation > 0 and baseline in (0, 90]", () => {
    const errors = validateAuditAlertDraft(
      draft({
        operatorKind: "rate_deviation",
        deviationPct: "0",
        baselineDays: "91",
      }),
    );
    expect(errors).toHaveLength(2);
    expect(
      validateAuditAlertDraft(
        draft({
          operatorKind: "rate_deviation",
          deviationPct: "50.5",
          baselineDays: "14",
        }),
      ),
    ).toEqual([]);
  });

  it("a non-numeric param is refused, never coerced to a silent zero", () => {
    expect(
      validateAuditAlertDraft(
        draft({
          operatorKind: "threshold_window",
          thresholdCount: "five",
          windowMin: "5",
        }),
      ).length,
    ).toBe(1);
  });
});

describe("buildAuditAlertCreateBody", () => {
  it("refuses an invalid draft outright", () => {
    expect(buildAuditAlertCreateBody(draft({ name: "" }))).toBeNull();
  });

  it("builds the minimal glob body with no empty optionals riding along", () => {
    const body = buildAuditAlertCreateBody(draft());
    expect(body).toEqual({
      name: "Subscriber exports",
      action_glob: "subscribers.export*",
      operator_kind: "glob",
      channel_kind: "email",
      channel_config: { to: "soc@example.com" },
    });
  });

  it("sends only the chosen channel's fields — a stray value from a previously selected kind never rides along", () => {
    const body = buildAuditAlertCreateBody(
      draft({
        channelKind: "email",
        channel: {
          to: "soc@example.com",
          // Typed while "slack" was selected, then the kind was changed:
          webhook_url: "https://hooks.slack.com/services/T/B/x",
        },
      }),
    );
    expect(body?.channel_config).toEqual({ to: "soc@example.com" });
  });

  it("carries operator config and narrowing for a threshold rule", () => {
    const body = buildAuditAlertCreateBody(
      draft({
        operatorKind: "threshold_window",
        thresholdCount: "5",
        windowMin: "10",
        groupByActorLabel: true,
        actorType: "user",
        notifySlack: true,
      }),
    );
    expect(body?.operator_kind).toBe("threshold_window");
    expect(body?.operator_config).toEqual({
      count: 5,
      window_min: 10,
      group_by: "actor_label",
    });
    expect(body?.actor_type).toBe("user");
    expect(body?.notify_slack).toBe(true);
  });

  it("outlier sends its detector kind", () => {
    const body = buildAuditAlertCreateBody(
      draft({ operatorKind: "outlier", outlierKind: "off_hours" }),
    );
    expect(body?.operator_config).toEqual({ kind: "off_hours" });
  });
});

describe("channel field specs", () => {
  it("marks every credential field secure", () => {
    const secureKeys = Object.values(AUDIT_ALERT_CHANNEL_FIELDS)
      .flat()
      .filter((f) => f.secure)
      .map((f) => f.key);
    for (const key of [
      "webhook_url",
      "url",
      "bearer_token",
      "password",
      "api_token",
      "routing_key",
    ]) {
      expect(secureKeys).toContain(key);
    }
  });
});
