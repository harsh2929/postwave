// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import {
  adminTools,
  MCP_OUTBOUND_WEBHOOK_EVENT_TYPES,
} from "../../src/tools/admin.js";

function makeClient() {
  const webhooks = {
    create: vi
      .fn()
      .mockResolvedValue({ webhook: { id: "wh_001" }, secret: "s" }),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    // The real method is `test(id)`. This mock used to be named `testFire`,
    // which matched nothing on WebhooksResource — so the assertion below was
    // green against a method the SDK has never shipped.
    test: vi.fn().mockResolvedValue({
      webhook_id: "wh_001",
      status_code: 200,
      signed: true,
    }),
    deliveriesList: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
  };
  const apiKeys = {
    create: vi
      .fn()
      .mockResolvedValue({ key: { id: "ak_001" }, plaintext: "pw_xyz" }),
    list: vi.fn().mockResolvedValue([]),
    revoke: vi.fn().mockResolvedValue({ ok: true }),
  };
  const chatProvider = {
    create: vi.fn().mockResolvedValue({ id: "chat_001" }),
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ id: "chat_001", enabled: false }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
  };
  const chatIntegrations = {
    forProvider: vi.fn().mockReturnValue(chatProvider),
  };
  const slackIntegrations = {
    create: vi.fn().mockResolvedValue({ id: "slack_001" }),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({ ok: true }),
  };
  return {
    client: { webhooks, apiKeys, chatIntegrations, slackIntegrations },
    webhooks,
    apiKeys,
    chatIntegrations,
    chatProvider,
    slackIntegrations,
  };
}

describe("adminTools", () => {
  it("exposes the admin tool surface", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = adminTools(client as any);
    expect(tools.map((t) => t.name)).toEqual([
      "webhook_create",
      "webhook_list",
      "webhook_delete",
      "webhook_test_fire",
      "webhook_deliveries_list",
      "api_key_create",
      "api_key_list",
      "api_key_revoke",
      "api_key_rotate",
      "slack_integration_create",
      "slack_integration_list",
      "slack_integration_delete",
      "chat_integration_create",
      "chat_integration_list",
      "chat_integration_update",
      "chat_integration_delete",
      "landing_page_create",
      "landing_page_list",
      "landing_page_publish",
      "campaign_report",
      "dashboard_stats",
      "sequence_job_wait",
    ]);
    for (const t of tools) expect(t.schema).toBeInstanceOf(z.ZodObject);
  });

  it("webhook_create rejects SSRF URLs before calling SDK", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = adminTools(c.client as any).find(
      (x) => x.name === "webhook_create",
    )!;
    await expect(
      t.handler({ url: "http://127.0.0.1/hook", events: ["subscriber.added"] }),
    ).rejects.toThrow();
    expect(c.webhooks.create).not.toHaveBeenCalled();
  });

  it("webhook_create accepts a public URL", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = adminTools(c.client as any).find(
      (x) => x.name === "webhook_create",
    )!;
    await t.handler({
      url: "https://example.invalid/hook",
      events: ["subscriber.added"],
    });
    expect(c.webhooks.create).toHaveBeenCalledTimes(1);
  });

  it("webhook_create validates the exact canonical outbound catalog", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = adminTools(c.client as any).find(
      (x) => x.name === "webhook_create",
    )!;
    for (const event of MCP_OUTBOUND_WEBHOOK_EVENT_TYPES) {
      expect(
        t.schema.safeParse({
          url: "https://example.invalid/hook",
          events: [event],
        }).success,
      ).toBe(true);
    }
    for (const legacyPhantom of [
      "subscriber.created",
      "campaign.opened",
      "automation.completed",
      "migration.completed",
      "form.submitted",
    ]) {
      expect(
        t.schema.safeParse({
          url: "https://example.invalid/hook",
          events: [legacyPhantom],
        }).success,
      ).toBe(false);
    }
  });

  it("api_key_revoke forwards id", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = adminTools(c.client as any).find(
      (x) => x.name === "api_key_revoke",
    )!;
    await t.handler({ id: "ak_001" });
    expect(c.apiKeys.revoke).toHaveBeenCalledWith("ak_001");
  });

  it("webhook_test_fire forwards only the id — the server hard-codes webhook.test", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = adminTools(c.client as any).find(
      (x) => x.name === "webhook_test_fire",
    )!;
    await t.handler({ id: "wh_001" });
    expect(c.webhooks.test).toHaveBeenCalledWith("wh_001");
    // An event_type is not accepted: the Test handler synthesizes the
    // sentinel `webhook.test` envelope regardless of what a caller asks for,
    // so advertising a selectable type would be a phantom parameter.
    expect(
      t.schema.safeParse({ id: "wh_001", event_type: "subscriber.created" })
        .success,
    ).toBe(true);
    expect(
      Object.keys((t.schema as unknown as { shape: object }).shape),
    ).toEqual(["id"]);
  });

  it("chat integration tools dispatch through the selected provider", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = adminTools(c.client as any);
    const create = tools.find((x) => x.name === "chat_integration_create")!;
    const list = tools.find((x) => x.name === "chat_integration_list")!;
    const update = tools.find((x) => x.name === "chat_integration_update")!;
    const del = tools.find((x) => x.name === "chat_integration_delete")!;

    await create.handler({
      provider: "discord",
      url: "https://discord.com/api/webhooks/123/token",
      events: ["subscriber.added"],
      channel_hint: "#growth",
    });
    await list.handler({ provider: "discord" });
    await update.handler({ provider: "teams", id: "teams/1", enabled: false });
    await del.handler({ provider: "slack", id: "slack/1" });

    expect(c.chatIntegrations.forProvider).toHaveBeenNthCalledWith(
      1,
      "discord",
    );
    expect(c.chatIntegrations.forProvider).toHaveBeenNthCalledWith(
      2,
      "discord",
    );
    expect(c.chatIntegrations.forProvider).toHaveBeenNthCalledWith(3, "teams");
    expect(c.chatIntegrations.forProvider).toHaveBeenNthCalledWith(4, "slack");
    expect(c.chatProvider.create).toHaveBeenCalledWith({
      url: "https://discord.com/api/webhooks/123/token",
      events: ["subscriber.added"],
      channel_hint: "#growth",
    });
    expect(c.chatProvider.update).toHaveBeenCalledWith("teams/1", {
      url: undefined,
      events: undefined,
      channel_hint: undefined,
      enabled: false,
    });
    expect(c.chatProvider.delete).toHaveBeenCalledWith("slack/1");
  });
});
