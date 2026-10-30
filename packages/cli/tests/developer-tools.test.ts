// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/lib/client.js";
import {
  apiKeyInputFromOptions,
  apiKeysCreate,
  apiKeysGet,
  apiKeysList,
  apiKeysRevoke,
  apiKeysRotate,
  inboundWebhooksCreate,
  inboundWebhooksDelete,
  inboundWebhooksEvents,
  inboundWebhooksGet,
  inboundWebhooksList,
  inboundWebhooksReplay,
  inboundWebhooksRotate,
  inboundWebhooksTriggerCreate,
  inboundWebhooksTriggers,
  inboundWebhooksUpdate,
  webhookInputFromOptions,
  webhooksCreate,
  webhooksDelete,
  webhooksDeliveries,
  webhooksList,
  webhooksReplay,
  webhooksRotate,
  webhooksTest,
  webhooksUpdate,
} from "../src/commands/developer-tools.js";

vi.mock("../src/lib/client.js", () => ({
  createClient: vi.fn(),
}));

function mockClient() {
  const apiKeys = {
    list: vi.fn(async () => [apiKeyFixture()]),
    get: vi.fn(async () => apiKeyFixture()),
    create: vi.fn(async () => ({ key: apiKeyFixture(), plaintext: "pw_secret" })),
    rotate: vi.fn(async () => ({ key: apiKeyFixture(), plaintext: "pw_rotated", revoked_id: "ak_1" })),
    revoke: vi.fn(async () => ({ ok: true })),
  };
  const webhooks = {
    list: vi.fn(async () => ({ webhooks: [webhookFixture()], next_cursor: null })),
    create: vi.fn(async () => ({ webhook: webhookFixture(), signing_secret: "owhsec_1" })),
    update: vi.fn(async () => webhookFixture()),
    delete: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ webhook_id: "wh_1", status_code: 200, signed: true })),
    deliveriesList: vi.fn(async () => ({
      deliveries: [{
        id: "delivery_1",
        webhook_id: "wh_1",
        event_type: "subscriber.added",
        status: "delivered",
        attempt_count: 1,
        last_status_code: 200,
        created_at: "2026-06-17T00:00:00Z",
      }],
      next_cursor: null,
    })),
    replay: vi.fn(async () => ({
      delivery_id: "delivery_child",
      replayed_from: "delivery_1",
      status: "pending",
      replayed_at: "2026-06-17T00:00:00Z",
    })),
    rotateSecret: vi.fn(async () => ({
      webhook: webhookFixture(),
      signing_secret: "owhsec_rotated",
    })),
  };
  const inboundWebhooks = {
    list: vi.fn(async () => ({ items: [inboundFixture()], next_cursor: null })),
    create: vi.fn(async () => ({ endpoint: inboundFixture(), secret: "insec_1" })),
    get: vi.fn(async () => inboundFixture()),
    update: vi.fn(async () => inboundFixture()),
    rotate: vi.fn(async () => ({ endpoint: inboundFixture(), secret: "insec_rotated" })),
    events: vi.fn(async () => ({ items: [], next_cursor: null })),
    replay: vi.fn(async () => ({
      ok: true,
      queued: true,
      replay_id: "replay_1",
      matches: [],
    })),
    triggers: vi.fn(async () => ({ items: [] })),
    createTrigger: vi.fn(async () => ({ id: "trigger_1" })),
    delete: vi.fn(async () => undefined),
  };
  vi.mocked(createClient).mockReturnValue({
    apiKeys,
    webhooks,
    inboundWebhooks,
  } as unknown as ReturnType<typeof createClient>);
  return { apiKeys, webhooks, inboundWebhooks };
}

function apiKeyFixture() {
  return {
    id: "ak_1",
    tenantId: "tenant_1",
    label: "Production",
    prefix: "pw_123",
    scopes: ["read:subscribers", "write:subscribers"],
    createdAt: "2026-06-17T00:00:00Z",
  };
}

function webhookFixture() {
  return {
    id: "wh_1",
    tenant_id: "tenant_1",
    url: "https://example.invalid/webhook",
    events: ["subscriber.added"],
    active: true,
    consecutive_failures: 0,
    signing_algorithm: "hmac_sha256",
    created_at: "2026-06-17T00:00:00Z",
    updated_at: "2026-06-17T00:00:00Z",
  };
}

function inboundFixture() {
  return {
    id: "inwh_1",
    tenantId: "tenant_1",
    slug: "customer-leads",
    name: "Customer leads",
    enabled: true,
    createdAt: "2026-06-17T00:00:00Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("developer tool CLI payload builders", () => {
  it("builds API key and webhook payloads from flags or JSON", () => {
    expect(
      apiKeyInputFromOptions({
        label: "Production",
        scopes: "read:subscribers,write:subscribers",
        sandboxOnly: "false",
      }),
    ).toEqual({
      label: "Production",
      scopes: ["read:subscribers", "write:subscribers"],
      sandbox_only: false,
    });

    expect(
      webhookInputFromOptions({
        url: "https://example.invalid/webhook",
        events: "subscriber.added,campaign.sent",
      }, true),
    ).toEqual({
      url: "https://example.invalid/webhook",
      events: ["subscriber.added", "campaign.sent"],
    });

    expect(() => apiKeyInputFromOptions({ label: "Production" })).toThrow(/--scopes/);
    expect(() => webhookInputFromOptions({}, true)).toThrow(/--url/);
  });
});

describe("developer tool CLI commands", () => {
  it("dispatches API key commands to the SDK", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { apiKeys } = mockClient();

    await apiKeysList({ output: "json" });
    await apiKeysGet("ak/1", { output: "json" });
    await apiKeysCreate({
      label: "Production",
      scopes: "read:subscribers,write:subscribers",
      output: "json",
    });
    await apiKeysRotate("ak/1", { output: "json" });
    await apiKeysRevoke("ak/1", { output: "json" });

    expect(apiKeys.list).toHaveBeenCalledTimes(1);
    expect(apiKeys.get).toHaveBeenCalledWith("ak/1");
    expect(apiKeys.create).toHaveBeenCalledWith({
      label: "Production",
      scopes: ["read:subscribers", "write:subscribers"],
    });
    expect(apiKeys.rotate).toHaveBeenCalledWith("ak/1");
    expect(apiKeys.revoke).toHaveBeenCalledWith("ak/1");
  });

  it("dispatches outbound and inbound webhook commands to the SDK", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { webhooks, inboundWebhooks } = mockClient();

    await webhooksList({ output: "json" });
    await webhooksCreate({
      url: "https://example.invalid/webhook",
      events: "subscriber.added,campaign.sent",
      output: "json",
    });
    await webhooksUpdate("wh/1", {
      events: "campaign.sent",
      output: "json",
    });
    await webhooksTest("wh/1", { output: "json" });
    await webhooksDeliveries("wh/1", { cursor: "cur_1", limit: 50, output: "json" });
    await webhooksReplay("delivery/1", {
      idempotencyKey: "replay-job-42",
      output: "json",
    });
    await webhooksRotate("wh/1", { graceMinutes: 60, output: "json" });
    await webhooksDelete("wh/1", { output: "json", yes: true });
    await inboundWebhooksList({ limit: 20, output: "json" });
    await inboundWebhooksCreate({
      name: "Customer leads",
      transformJq: ".payload",
      output: "json",
    });
    await inboundWebhooksGet("inwh/1", { output: "json" });
    await inboundWebhooksUpdate("inwh/1", {
      name: "Renamed",
      enabled: false,
      output: "json",
    });
    await inboundWebhooksRotate("inwh/1", { output: "json" });
    await inboundWebhooksEvents("inwh/1", { limit: 25, output: "json" });
    await inboundWebhooksReplay("inwh/1", "event/7", {
      idempotencyKey: "inbound-replay-job-42",
      output: "json",
    });
    await inboundWebhooksTriggers("inwh/1", { output: "json" });
    const trigger = {
      name: "Welcome",
      match_jsonpath: "$.kind",
      match_operator: "equals",
      match_value: "signup",
      email_jsonpath: "$.email",
      action_type: "add_to_sequence",
      action_target_id: "seq_1",
    };
    await inboundWebhooksTriggerCreate("inwh/1", {
      payload: JSON.stringify(trigger),
      output: "json",
    });
    await inboundWebhooksDelete("inwh/1", { output: "json", yes: true });

    expect(webhooks.list).toHaveBeenCalledTimes(1);
    expect(webhooks.create).toHaveBeenCalledWith({
      url: "https://example.invalid/webhook",
      events: ["subscriber.added", "campaign.sent"],
    });
    expect(webhooks.update).toHaveBeenCalledWith("wh/1", {
      events: ["campaign.sent"],
    });
    expect(webhooks.test).toHaveBeenCalledWith("wh/1");
    expect(webhooks.deliveriesList).toHaveBeenCalledWith("wh/1", {
      cursor: "cur_1",
      limit: 50,
    });
    expect(webhooks.replay).toHaveBeenCalledWith("delivery/1", "replay-job-42");
    expect(webhooks.rotateSecret).toHaveBeenCalledWith("wh/1", 60);
    expect(webhooks.delete).toHaveBeenCalledWith("wh/1");
    expect(inboundWebhooks.list).toHaveBeenCalledWith({ limit: 20 });
    expect(inboundWebhooks.create).toHaveBeenCalledWith({
      name: "Customer leads",
      transform_jq: ".payload",
    });
    expect(inboundWebhooks.get).toHaveBeenCalledWith("inwh/1");
    expect(inboundWebhooks.update).toHaveBeenCalledWith("inwh/1", {
      name: "Renamed",
      enabled: false,
    });
    expect(inboundWebhooks.rotate).toHaveBeenCalledWith("inwh/1");
    expect(inboundWebhooks.events).toHaveBeenCalledWith("inwh/1", { limit: 25 });
    expect(inboundWebhooks.replay).toHaveBeenCalledWith(
      "inwh/1",
      "event/7",
      "inbound-replay-job-42",
    );
    expect(inboundWebhooks.triggers).toHaveBeenCalledWith("inwh/1");
    expect(inboundWebhooks.createTrigger).toHaveBeenCalledWith("inwh/1", trigger);
    expect(inboundWebhooks.delete).toHaveBeenCalledWith("inwh/1");
  });

  it("requires a caller-stable idempotency key for both replay commands", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { webhooks, inboundWebhooks } = mockClient();

    await webhooksReplay("delivery_1", { output: "json" });
    await inboundWebhooksReplay("inwh_1", "7", { output: "json" });

    expect(webhooks.replay).not.toHaveBeenCalled();
    expect(inboundWebhooks.replay).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
