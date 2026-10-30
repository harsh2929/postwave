import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createAuditDeliveryOperationsMethods,
  type AuditDeliveryOperationsDependencies,
  type AuditDeliveryRequester,
  type AuditDeliveryRequestOptions,
} from "../../lib/api/audit-delivery-operations";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: AuditDeliveryRequestOptions | undefined;
}

const METHOD_NAMES = [
  "auditSinksList",
  "auditSinkCreate",
  "auditSinkPatch",
  "auditSinkDelete",
  "auditSinkTest",
  "auditSinkTestExisting",
  "auditSinkDLQList",
  "auditSinkSigningKeysList",
  "auditSinkRotateKey",
  "auditSinkJWKS",
  "auditSinkDLQReplay",
  "auditSinkCircuitReset",
  "auditAlertsList",
  "auditAlertCreate",
  "auditAlertPatch",
  "auditAlertDelete",
  "auditAlertIncidents",
  "auditAlertVerifyServiceNow",
  "auditAlertVerifyJira",
  "auditAlertVerifyPagerDuty",
  "auditSinkReplay",
  "auditSinkReplayJobsList",
  "auditSinkReplayJobGet",
  "auditSinkReplayJobCancel",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const queuedResponses = [...responses];
  const request: AuditDeliveryRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: AuditDeliveryRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (queuedResponses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  const dependencies: AuditDeliveryOperationsDependencies = { request };
  return {
    calls,
    methods: createAuditDeliveryOperationsMethods(dependencies),
  };
}

describe("audit delivery operations API extraction contracts", () => {
  it("retains the exact ordered 24-method inventory without eager work", () => {
    const { calls, methods } = createHarness();

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
  });

  it("preserves sink CRUD and canary transports without altering credentials", async () => {
    const { calls, methods } = createHarness();
    const input = {
      kind: "http" as const,
      name: "Sentinel SOC",
      enabled: true,
      config: { url: "https://soc.example.test/events" },
      credentials: { token: "secret" },
      output_format: "ocsf_1_8" as const,
      webhook_format: "standard_webhooks" as const,
    };
    const patch = {
      enabled: false,
      name: "Sentinel paused",
      credentials: { token: "rotated" },
    };

    await methods.auditSinksList();
    await methods.auditSinkCreate(input);
    await methods.auditSinkPatch("sink/one", patch);
    await methods.auditSinkDelete("sink/one");
    await methods.auditSinkTest(input);
    await methods.auditSinkTestExisting("sink/one");

    expect(calls).toEqual([
      { path: "/api/v1/audit-sinks", init: undefined, opts: undefined },
      {
        path: "/api/v1/audit-sinks",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone",
        init: { method: "PATCH", body: JSON.stringify(patch) },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/test",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone/test",
        init: { method: "POST" },
        opts: undefined,
      },
    ]);
  });

  it("preserves DLQ, signing-key, JWKS, replay, and circuit-reset transports", async () => {
    const { calls, methods } = createHarness();

    await methods.auditSinkDLQList();
    await methods.auditSinkSigningKeysList("sink/one");
    await methods.auditSinkRotateKey("sink/one");
    await methods.auditSinkJWKS("sink/one");
    await methods.auditSinkDLQReplay(42);
    await methods.auditSinkCircuitReset("sink/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/audit-sinks/dlq",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone/signing-keys",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone/rotate-key",
        init: { method: "POST" },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone/.well-known/jwks.json",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/dlq/42/replay",
        init: { method: "POST" },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone/circuit/reset",
        init: { method: "POST" },
        opts: undefined,
      },
    ]);
  });

  it("preserves alert rule CRUD and linked-incident transports", async () => {
    const { calls, methods } = createHarness();
    const input = {
      name: "Privilege escalation",
      action_glob: "role.*",
      actor_type: "human",
      actor_label_glob: "*@example.com",
      resource_type: "role",
      operator_kind: "threshold_window" as const,
      operator_config: { count: 3, window_seconds: 300 },
      channel_kind: "servicenow" as const,
      channel_config: { assignment_group: "SOC" },
      notify_slack: true,
    };
    const patch = {
      enabled: false,
      name: "Privilege escalation paused",
      channel_config: { assignment_group: "Security" },
      notify_slack: false,
    };

    await methods.auditAlertsList();
    await methods.auditAlertCreate(input);
    await methods.auditAlertPatch("rule/one", patch);
    await methods.auditAlertDelete("rule/one");
    await methods.auditAlertIncidents("rule/one");

    expect(calls).toEqual([
      { path: "/api/v1/audit-alerts", init: undefined, opts: undefined },
      {
        path: "/api/v1/audit-alerts",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-alerts/rule%2Fone",
        init: { method: "PATCH", body: JSON.stringify(patch) },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-alerts/rule%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-alerts/rule%2Fone/incidents",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves ServiceNow, Jira, and PagerDuty credential-verification transports", async () => {
    const { calls, methods } = createHarness();
    const serviceNow = { instance: "acme", username: "ada", password: "pw" };
    const jira = { base_url: "https://acme.atlassian.net", token: "jira" };
    const pagerDuty = { routing_key: "pd-key" };

    await methods.auditAlertVerifyServiceNow(serviceNow);
    await methods.auditAlertVerifyJira(jira);
    await methods.auditAlertVerifyPagerDuty(pagerDuty);

    expect(calls).toEqual([
      {
        path: "/api/v1/audit-alerts/servicenow/auth",
        init: { method: "POST", body: JSON.stringify(serviceNow) },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-alerts/jira/auth",
        init: { method: "POST", body: JSON.stringify(jira) },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-alerts/pagerduty/auth",
        init: { method: "POST", body: JSON.stringify(pagerDuty) },
        opts: undefined,
      },
    ]);
  });

  it("preserves cursor-based audit replay creation, listing, polling, and cancellation", async () => {
    const { calls, methods } = createHarness();
    const input = { from_id: 100, to_id: 500 };

    await methods.auditSinkReplay("sink/one", input);
    await methods.auditSinkReplayJobsList("sink/one", {
      cursor: "job/cursor",
      limit: 25,
    });
    await methods.auditSinkReplayJobGet("sink/one", "job/one");
    await methods.auditSinkReplayJobCancel("sink/one", "job/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/audit-sinks/sink%2Fone/replay",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone/replay-jobs?cursor=job%2Fcursor&limit=25",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone/replay-jobs/job%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone/replay-jobs/job%2Fone/cancel",
        init: { method: "POST" },
        opts: undefined,
      },
    ]);
  });

  it("retains empty replay-query defaults and passes request errors through unchanged", async () => {
    const expectedError: ApiErr = {
      error: { kind: "http", status: 503, message: "Unavailable" },
    };
    const { calls, methods } = createHarness([expectedError]);

    await expect(methods.auditSinkReplayJobsList("sink/one")).resolves.toBe(
      expectedError,
    );
    await methods.auditSinkReplayJobsList("sink/one", {
      cursor: "",
      limit: 0,
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/audit-sinks/sink%2Fone/replay-jobs",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit-sinks/sink%2Fone/replay-jobs",
        init: undefined,
        opts: undefined,
      },
    ]);
  });
});
