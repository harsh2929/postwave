/**
 * Audit alerts — the render contract for the detection roster and its sheet.
 *
 * WHAT THIS FILE EXISTS TO CATCH. Every failure mode of a governance screen is
 * a sentence that is WRONG rather than a screen that is blank:
 *
 *   - "No alert rules" shown to somebody who merely lacks `audit:read` tells
 *     them nothing is watching their audit log. It is the single most damaging
 *     string this app can render, and three separate states can produce it if
 *     the ladder collapses — a refusal, a failed fetch, and a closed gate.
 *   - "Enabled" shown as a green pill and nothing else leaves a screen-reader
 *     user with no state at all, and leaves everyone with no idea that an
 *     enabled rule has matched nothing in a month.
 *   - An empty incidents array rendered before the fetch lands reads as "no
 *     tickets are open", which is an all-clear nobody earned.
 *
 * WHY THE SHEET IS RENDERED DIRECTLY RATHER THAN OPENED BY A TAP. The
 * `@tanstack/react-query` harness sets ONE result for every `useQuery` in the
 * module graph, so opening the sheet from the list would hand the fire history
 * and the incident page the rule array and vice versa — the mock-shape
 * mismatch that makes a suite pass while asserting nothing. The sheet takes its
 * data as props, so it is driven with genuinely fire- and incident-shaped
 * payloads here while the route keeps rule-shaped ones.
 *
 * The pure decisions (ordering, scope arithmetic, attention thresholds, the
 * https-only link filter) are pinned in lib/auditAlert{Policy,Rules,Incidents}
 * .test.ts; this file proves they reach the screen.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AuditAlertCreateSheet } from "@/components/audit/AuditAlertCreateSheet";
import { AuditAlertDetailSheet } from "@/components/audit/AuditAlertDetailSheet";
import * as AuditHooks from "@/hooks/useAudit";
import { parseAuditAlertIncidentPage } from "@/lib/auditAlertIncidents";
import {
  parseAuditAlertFireList,
  parseAuditAlertRule,
  type AuditAlertRule,
} from "@/lib/auditAlertRules";

import AuditAlerts from "../app/(tabs)/audit-alerts";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
/**
 * `@/hooks/useAudit` and `@/hooks/useOnlineQueryGate` resolve to the SAME
 * jest mock module (see jest.routes.config.cjs), so one handle drives both the
 * online gate and the scope answer.
 */
const hookHarness = AuditHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetOnlineGateForTests();
  hookHarness.__resetHookResultsForTests();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
    last_fired_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    last_error: "",
    created_at: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    ...overrides,
  };
}

function rule(overrides: Record<string, unknown> = {}): AuditAlertRule {
  const parsed = parseAuditAlertRule(wireRule(overrides));
  if (!parsed) throw new Error("fixture failed to parse");
  return parsed;
}

/** The exact shape `useAuditAlertRules` resolves to: `AuditAlertRule[]`. */
function loaded(rules: readonly AuditAlertRule[]) {
  return {
    data: rules,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: rules })),
  };
}

/**
 * Grant the read scope AND settle the my-scopes query.
 *
 * Both halves matter: the screen treats "the scope answer has not arrived" as
 * part of loading, so a test that granted the verdict but left the query
 * pending would still be asserting against a skeleton.
 */
function grantScopes(
  overrides: {
    read?: boolean | null;
    isAdmin?: boolean;
    auditScopes?: string[];
  } = {},
) {
  const read = overrides.read ?? true;
  hookHarness.__setHookResultForTests("hasAuditReadScope", read);
  hookHarness.__setHookResultForTests("useAuditScopes", {
    data: {
      scopes: ["audit:read", "audit:configure_sinks"],
      auditScopes: overrides.auditScopes ?? [
        "audit:read",
        "audit:configure_sinks",
      ],
      isAdmin: overrides.isAdmin ?? true,
    },
    error: null,
    isError: false,
    isLoading: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
  });
}

describe("the alert roster's five states", () => {
  it("1. loading: shows a skeleton, and never an all-clear", async () => {
    // Default harness: my-scopes pending, rules pending.
    await render(<AuditAlerts />, { wrapper });

    expect(screen.getByLabelText("Loading alert rules")).toBeTruthy();
    expect(screen.queryByText("No alert rules")).toBeNull();
    // The counter is unknowable, so it is a dash — never "0 of 0".
    expect(screen.getByText(/— watching/)).toBeTruthy();
  });

  it("1b. stays in the loading state while ONLY the scope answer is missing", async () => {
    // The rules query has resolved but my-scopes has not. Without the scope
    // term in `stillResolving` this renders "No alert rules" — an all-clear
    // assembled from an answer nobody has given yet.
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<AuditAlerts />, { wrapper });

    expect(screen.queryByText("No alert rules")).toBeNull();
    expect(screen.getByLabelText("Loading alert rules")).toBeTruthy();
  });

  it("2. error: renders the failure, never 'no alert rules'", async () => {
    grantScopes();
    queryHarness.__setQueryResultForTests({
      data: undefined,
      error: new Error("boom"),
      isError: true,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isRefetching: false,
      isSuccess: false,
      refetch: jest.fn(async () => ({ data: undefined })),
    });

    await render(<AuditAlerts />, { wrapper });

    expect(screen.queryByText("No alert rules")).toBeNull();
    expect(screen.getByText(/— watching/)).toBeTruthy();
  });

  it("3. offline: says so, and refuses to serve a cached all-clear", async () => {
    grantScopes();
    hookHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<AuditAlerts />, { wrapper });

    expect(
      screen.getByText(/Connect to your workspace to load the alert roster/),
    ).toBeTruthy();
    expect(screen.queryByText("No alert rules")).toBeNull();
  });

  it("4. empty: says the roster is genuinely empty, and where rules come from", async () => {
    grantScopes();
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<AuditAlerts />, { wrapper });

    expect(screen.getByText("No alert rules")).toBeTruthy();
    // An admin is pointed at the on-screen create verb, never at a desk.
    expect(screen.getByText(/Create a rule with New rule above/)).toBeTruthy();
  });

  it("4b. empty for a non-admin: points at an admin, and offers no create verb", async () => {
    grantScopes({ isAdmin: false, auditScopes: ["audit:read"] });
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<AuditAlerts />, { wrapper });

    expect(screen.getByText(/A workspace admin can create rules/)).toBeTruthy();
    expect(screen.queryByLabelText("New alert rule")).toBeNull();
  });

  it("5. content: renders the rule, what it watches, and where it delivers", async () => {
    grantScopes();
    queryHarness.__setQueryResultForTests(loaded([rule()]));

    await render(<AuditAlerts />, { wrapper });

    expect(screen.getByText("Subscriber exports")).toBeTruthy();
    expect(
      screen.getByText("Every audit event matching subscribers.export*"),
    ).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.getByText("1 of 1 rule watching")).toBeTruthy();
  });
});

describe("the no-scope branch", () => {
  it("says the read was REFUSED, and never that the roster is empty", async () => {
    // The single most damaging confusion this screen can make: a viewer who
    // may not read the rules being told there are none.
    grantScopes({ read: false, isAdmin: false, auditScopes: [] });
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<AuditAlerts />, { wrapper });

    expect(
      screen.getByText(/Audit alerts need the audit:read scope/),
    ).toBeTruthy();
    expect(screen.queryByText("No alert rules")).toBeNull();
    expect(screen.queryByText(/Nothing is watching the audit log/)).toBeNull();
    // …and it does not render a roster it was not allowed to fetch.
    expect(screen.queryByText("Subscriber exports")).toBeNull();
  });

  it("renders no permission verdict at all while the answer is in flight", async () => {
    // hasAuditReadScope() === null. Neither the refusal nor the roster.
    queryHarness.__setQueryResultForTests(loaded([rule()]));

    await render(<AuditAlerts />, { wrapper });

    expect(screen.queryByText(/need the audit:read scope/)).toBeNull();
    expect(screen.queryByText(/Read-only for your permissions/)).toBeNull();
  });
});

describe("rule state is never colour alone", () => {
  it("gives an enabled, a paused and a failing rule three different WORDS", async () => {
    grantScopes();
    queryHarness.__setQueryResultForTests(
      loaded([
        rule({ id: "a", name: "Watching", enabled: true, last_error: "" }),
        rule({ id: "b", name: "Switched off", enabled: false }),
        rule({ id: "c", name: "Broken", enabled: true, last_error: "smtp: 550" }),
      ]),
    );

    await render(<AuditAlerts />, { wrapper });

    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("Delivery failing")).toBeTruthy();
  });

  it("spells the state out for a screen reader, which cannot see the pill", async () => {
    grantScopes();
    queryHarness.__setQueryResultForTests(
      loaded([rule({ name: "Switched off", enabled: false })]),
    );

    await render(<AuditAlerts />, { wrapper });

    expect(
      screen.getByLabelText(
        /Paused\. This rule is not watching the audit log\./,
      ),
    ).toBeTruthy();
  });

  it("counts the failing rules in a sentence, not just in red", async () => {
    grantScopes();
    queryHarness.__setQueryResultForTests(
      loaded([
        rule({ id: "c", name: "Broken", enabled: true, last_error: "smtp: 550" }),
      ]),
    );

    await render(<AuditAlerts />, { wrapper });

    expect(
      screen.getByText("1 rule enabled but failing to deliver."),
    ).toBeTruthy();
  });
});

describe("a rule nothing has matched", () => {
  it("badges an enabled rule that has never fired, and dates the silence", async () => {
    grantScopes();
    queryHarness.__setQueryResultForTests(
      loaded([
        rule({
          name: "Impossible travel",
          last_fired_at: null,
          fired_count: 0,
          created_at: new Date(Date.now() - 30 * DAY_MS).toISOString(),
        }),
      ]),
    );

    await render(<AuditAlerts />, { wrapper });

    expect(screen.getByText("Never fired")).toBeTruthy();
    expect(
      screen.getByText("1 rule enabled but nothing has matched recently."),
    ).toBeTruthy();
  });

  it("says nothing about a rule that fired this week", async () => {
    grantScopes();
    queryHarness.__setQueryResultForTests(loaded([rule()]));

    await render(<AuditAlerts />, { wrapper });

    expect(screen.queryByText("Never fired")).toBeNull();
    expect(screen.queryByText("No recent fires")).toBeNull();
  });

  it("renders a missing fire count as a dash, never as zero fires", async () => {
    grantScopes();
    queryHarness.__setQueryResultForTests(
      loaded([rule({ fired_count: null })]),
    );

    await render(<AuditAlerts />, { wrapper });

    expect(screen.queryByText(/0 fires/)).toBeNull();
    // The compacted line is a dash; the spoken form says WHY it is a dash,
    // because "—" alone is indistinguishable from "none" to a screen reader.
    expect(screen.getByLabelText(/Fire count unavailable/)).toBeTruthy();
  });
});

describe("the write gate", () => {
  it("tells a non-admin session what it actually needs, and still shows the rules", async () => {
    grantScopes({ isAdmin: false, auditScopes: ["audit:read"] });
    queryHarness.__setQueryResultForTests(loaded([rule()]));

    await render(<AuditAlerts />, { wrapper });

    expect(screen.getByText(/Read-only for your permissions/)).toBeTruthy();
    expect(screen.getByText(/owner or admin role/)).toBeTruthy();
    // A read-only actor still gets the whole roster — the refusal is about the
    // toggle, not about the read.
    expect(screen.getByText("Subscriber exports")).toBeTruthy();
  });

  it("tells an admin whose role lost audit:configure_sinks the real reason", async () => {
    // routeauth's role floor passes; the mount's RequireScope does not.
    grantScopes({ isAdmin: true, auditScopes: ["audit:read"] });
    queryHarness.__setQueryResultForTests(loaded([rule()]));

    await render(<AuditAlerts />, { wrapper });

    expect(screen.getByText(/audit:configure_sinks/)).toBeTruthy();
  });

  it("says nothing about permissions to an admin who has them", async () => {
    grantScopes();
    queryHarness.__setQueryResultForTests(loaded([rule()]));

    await render(<AuditAlerts />, { wrapper });

    expect(screen.queryByText(/Read-only for your permissions/)).toBeNull();
    expect(screen.queryByText(/owner or admin role/)).toBeNull();
  });
});

/** The exact shape `useAuditAlertFires` resolves to: `AuditAlertFire[]`. */
const FIRES = parseAuditAlertFireList({
  fires: [
    {
      id: 2,
      audit_id: 90211,
      delivered: false,
      delivery_error: "servicenow: 401 unauthorized",
      fired_at: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      id: 1,
      audit_id: 90210,
      delivered: true,
      delivery_error: "",
      fired_at: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    },
  ],
});

/** The exact shape `useAuditAlertIncidents` resolves to: a page + cursor. */
const INCIDENTS = parseAuditAlertIncidentPage({
  incidents: [
    {
      id: 7,
      rule_id: "9d2b7f6e-0000-4000-8000-000000000001",
      audit_id: 90210,
      external_system: "servicenow",
      external_incident_id: "INC0012345",
      incident_status: "open",
      incident_url: "https://acme.service-now.com/incident.do?sys_id=abc",
      last_synced_at: new Date(Date.now() - 3600_000).toISOString(),
      created_at: new Date(Date.now() - 3 * DAY_MS).toISOString(),
      updated_at: new Date(Date.now() - 3600_000).toISOString(),
    },
    {
      id: 6,
      rule_id: "9d2b7f6e-0000-4000-8000-000000000001",
      audit_id: 90209,
      external_system: "jira",
      external_incident_id: "SEC-42",
      incident_status: "resolved",
      incident_url: "https://acme.atlassian.net/browse/SEC-42",
      last_synced_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
      created_at: new Date(Date.now() - 5 * DAY_MS).toISOString(),
      updated_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    },
  ],
});

function sheetProps(overrides: Record<string, unknown> = {}) {
  return {
    rule: rule({ channel_kind: "servicenow", channel_config: { instance_url: "https://acme.service-now.com" } }),
    fires: FIRES,
    firesLoading: false,
    firesFailed: false,
    incidents: INCIDENTS.incidents,
    incidentsLoading: false,
    incidentsFailed: false,
    incidentsTruncated: false,
    onClose: jest.fn(),
    onToggle: jest.fn(),
    toggling: false,
    canToggle: true,
    toggleNotice: null,
    onToggleSlack: jest.fn(),
    slackToggling: false,
    onDelete: jest.fn(),
    deleting: false,
    now: Date.now(),
    ...overrides,
  };
}

describe("the rule sheet: deliveries", () => {
  it("shows each attempt's outcome as a word, and the server's own error", async () => {
    await render(<AuditAlertDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("Delivered")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(
      screen.getByText("servicenow: 401 unauthorized"),
    ).toBeTruthy();
  });

  it("refuses to call an unloaded history 'never fired'", async () => {
    await render(
      <AuditAlertDetailSheet
        {...sheetProps({ fires: [], firesLoading: true })}
      />,
      { wrapper },
    );

    expect(screen.getByText("Checking recent deliveries…")).toBeTruthy();
    expect(screen.queryByText(/No deliveries recorded/)).toBeNull();
  });

  it("renders a failed history fetch as an error, never as 'no deliveries'", async () => {
    await render(
      <AuditAlertDetailSheet
        {...sheetProps({ fires: [], firesFailed: true })}
      />,
      { wrapper },
    );

    expect(screen.queryByText(/No deliveries recorded/)).toBeNull();
  });
});

describe("the rule sheet: linked incidents", () => {
  it("is the only place the tickets appear, with system, id and status", async () => {
    await render(<AuditAlertDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("ServiceNow · INC0012345")).toBeTruthy();
    expect(screen.getByText("Jira · SEC-42")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("Resolved")).toBeTruthy();
  });

  it("counts what is still outstanding — the reason to look at all", async () => {
    await render(<AuditAlertDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("1 incident still outstanding.")).toBeTruthy();
  });

  it("says every ticket is finished only when every ticket is finished", async () => {
    await render(
      <AuditAlertDetailSheet
        {...sheetProps({
          incidents: parseAuditAlertIncidentPage({
            incidents: [
              {
                id: 6,
                external_system: "jira",
                external_incident_id: "SEC-42",
                incident_status: "closed",
              },
            ],
          }).incidents,
        })}
      />,
      { wrapper },
    );

    expect(
      screen.getByText("Every linked incident has been resolved or closed."),
    ).toBeTruthy();
  });

  it("never reads a ticket with no synced status as a finished one", async () => {
    await render(
      <AuditAlertDetailSheet
        {...sheetProps({
          incidents: parseAuditAlertIncidentPage({
            incidents: [
              {
                id: 9,
                external_system: "pagerduty",
                external_incident_id: "PD-7",
                incident_status: "",
              },
            ],
          }).incidents,
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText("Status not synced")).toBeTruthy();
    expect(screen.getByText("1 incident still outstanding.")).toBeTruthy();
    expect(screen.getByText(/never synced/)).toBeTruthy();
  });

  it("refuses to call an unloaded incident list 'no tickets'", async () => {
    await render(
      <AuditAlertDetailSheet
        {...sheetProps({ incidents: [], incidentsLoading: true })}
      />,
      { wrapper },
    );

    expect(screen.getByText("Checking linked incidents…")).toBeTruthy();
    expect(
      screen.queryByText(/No tickets have been opened by this rule/),
    ).toBeNull();
  });

  it("renders a failed incident fetch as an error, never as 'no tickets'", async () => {
    await render(
      <AuditAlertDetailSheet
        {...sheetProps({ incidents: [], incidentsFailed: true })}
      />,
      { wrapper },
    );

    expect(
      screen.getByText(/whether any are still open is unknown/),
    ).toBeTruthy();
    expect(
      screen.queryByText(/No tickets have been opened by this rule/),
    ).toBeNull();
  });

  it("renders a genuinely empty incident list as empty, and says which channels make them", async () => {
    await render(
      <AuditAlertDetailSheet {...sheetProps({ incidents: [] })} />,
      { wrapper },
    );

    expect(
      screen.getByText(/No tickets have been opened by this rule/),
    ).toBeTruthy();
  });

  it("admits when the server withheld older incidents", async () => {
    await render(
      <AuditAlertDetailSheet {...sheetProps({ incidentsTruncated: true })} />,
      { wrapper },
    );

    expect(screen.getByText(/Older incidents exist beyond this page/)).toBeTruthy();
  });

  it("offers an https ticket link", async () => {
    await render(<AuditAlertDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("Open in ServiceNow")).toBeTruthy();
  });

  it("offers no link at all for a scheme that is not https", async () => {
    // `incident_url` is overridable by whatever POSTs the inbound webhook, so
    // this string is external input on the way to Linking.openURL.
    await render(
      <AuditAlertDetailSheet
        {...sheetProps({
          incidents: parseAuditAlertIncidentPage({
            incidents: [
              {
                id: 9,
                external_system: "servicenow",
                external_incident_id: "INC1",
                incident_status: "open",
                incident_url: "javascript:alert(1)",
              },
            ],
          }).incidents,
        })}
      />,
      { wrapper },
    );
    expect(screen.queryByText("Open in ServiceNow")).toBeNull();
  });
});

describe("the rule sheet: the one write", () => {
  it("offers Pause to somebody who may pause", async () => {
    await render(<AuditAlertDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByLabelText("Pause rule")).toBeTruthy();
  });

  it("disables the control and says WHY, instead of letting them find a 403", async () => {
    await render(
      <AuditAlertDetailSheet
        {...sheetProps({
          canToggle: false,
          toggleNotice: "Pausing and resuming alert rules needs an owner or admin role on this workspace. You can read every rule here.",
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/owner or admin role/)).toBeTruthy();
    const control = screen.getByLabelText("Pause rule");
    expect(control.props.accessibilityState.disabled).toBe(true);
  });

  it("offers the Slack fan-out switch to a writer, reflecting the rule's state", async () => {
    const onToggleSlack = jest.fn();
    await render(
      <AuditAlertDetailSheet
        {...sheetProps({
          rule: rule({ notify_slack: false }),
          onToggleSlack,
        })}
      />,
      { wrapper },
    );

    const row = screen.getByLabelText("Also notify the workspace Slack");
    expect(row.props.accessibilityState.checked).toBe(false);
  });

  it("withholds the Slack switch and the delete verb from a read-only actor", async () => {
    await render(
      <AuditAlertDetailSheet {...sheetProps({ canToggle: false })} />,
      { wrapper },
    );

    // Withheld entirely, never disabled: a 403 must read as a rule.
    expect(
      screen.queryByLabelText("Also notify the workspace Slack"),
    ).toBeNull();
    expect(screen.queryByLabelText("Delete rule")).toBeNull();
  });

  it("offers Delete to a writer and routes it through the screen's confirm", async () => {
    const onDelete = jest.fn();
    await render(<AuditAlertDetailSheet {...sheetProps({ onDelete })} />, {
      wrapper,
    });

    await fireEvent.press(screen.getByLabelText("Delete rule"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("never renders channel_config, which is where the credential lives", async () => {
    await render(
      <AuditAlertDetailSheet
        {...sheetProps({
          rule: rule({
            channel_kind: "slack",
            channel_config: {
              webhook_url: "https://hooks.slack.com/services/T0/B0/SECRET",
            },
          }),
        })}
      />,
      { wrapper },
    );

    expect(screen.queryByText(/SECRET/)).toBeNull();
    expect(screen.queryByText(/hooks\.slack\.com/)).toBeNull();
  });
});

describe("the create sheet", () => {
  function createProps(overrides: Record<string, unknown> = {}) {
    return {
      visible: true,
      onClose: jest.fn(),
      creating: false,
      serverError: null,
      onSubmit: jest.fn(),
      ...overrides,
    };
  }

  it("refuses an empty draft with the exact rules, and submits nothing", async () => {
    const onSubmit = jest.fn();
    await render(<AuditAlertCreateSheet {...createProps({ onSubmit })} />, {
      wrapper,
    });

    await fireEvent.press(screen.getByLabelText("Create rule"));
    expect(screen.getByText("Name the rule.")).toBeTruthy();
    expect(screen.getByText(/which actions to watch/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a valid email rule as the exact wire body", async () => {
    const onSubmit = jest.fn();
    await render(<AuditAlertCreateSheet {...createProps({ onSubmit })} />, {
      wrapper,
    });

    await fireEvent.changeText(
      screen.getByLabelText("Name"),
      "Subscriber exports",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Watch actions matching"),
      "subscribers.export*",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Deliver to"),
      "soc@example.com",
    );
    await fireEvent.press(screen.getByLabelText("Create rule"));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Subscriber exports",
      action_glob: "subscribers.export*",
      operator_kind: "glob",
      channel_kind: "email",
      channel_config: { to: "soc@example.com" },
    });
  });

  it("masks every credential field — a typed secret is never echoed", async () => {
    await render(<AuditAlertCreateSheet {...createProps()} />, { wrapper });

    await fireEvent.press(screen.getByText("Slack webhook"));
    const secret = screen.getByLabelText("Slack webhook URL");
    expect(secret.props.secureTextEntry).toBe(true);
  });

  it("renders the server's refusal inside the sheet, beside the fields", async () => {
    await render(
      <AuditAlertCreateSheet
        {...createProps({ serverError: "Your role no longer allows changing alert rules. Ask an admin." })}
      />,
      { wrapper },
    );

    expect(
      screen.getByText(/no longer allows changing alert rules/),
    ).toBeTruthy();
  });
});
