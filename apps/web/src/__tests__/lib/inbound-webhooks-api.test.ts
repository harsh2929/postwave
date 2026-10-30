// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
  },
}));

import {
  getInboundWebhook,
  listInboundTriggers,
  listInboundWebhooks,
  listInboundWebhookEvents,
  normalizeInboundEventPage,
  normalizeInboundReplayResult,
  replayInboundEvent,
} from "@/lib/inbound-webhooks-api";

const event = {
  id: 7,
  endpoint_id: "endpoint_1",
  headers: { "Content-Type": "application/json" },
  body: '{"ok":true}',
  signature_valid: true,
  received_at: "2026-08-25T00:00:00.000Z",
};

const replay = {
  ok: true,
  queued: true,
  replay_id: "replay_1",
  matches: [
    {
      trigger_id: "trigger_1",
      name: "Tag",
      subscriber_email: "person@example.test",
      action_type: "add_tag",
      action_target_id: "launch",
      queued: true,
      executed: false,
    },
  ],
};

beforeEach(() => {
  mocks.get.mockResolvedValue({ items: [event] });
  mocks.post.mockResolvedValue(replay);
});

describe("inbound event wire normalization", () => {
  it("accepts the mounted event and replay envelopes", () => {
    expect(
      normalizeInboundEventPage({ items: [event], next_cursor: "cursor_2" }),
    ).toEqual({ items: [event], next_cursor: "cursor_2" });
    expect(normalizeInboundReplayResult(replay)).toEqual(replay);
  });

  it.each([
    null,
    {},
    { items: null },
    { items: [null] },
    { items: [{ ...event, id: 0 }] },
    { items: [{ ...event, headers: { Authorization: 42 } }] },
    { items: [{ ...event, signature_valid: "yes" }] },
  ])(
    "rejects malformed event history instead of presenting empty (%j)",
    (wire) => {
      expect(() => normalizeInboundEventPage(wire)).toThrow(/malformed/i);
    },
  );

  it.each([
    null,
    {},
    { ...replay, queued: false },
    { ...replay, replay_id: "" },
    { ...replay, matches: {} },
    { ...replay, matches: [{ ...replay.matches[0], executed: "no" }] },
  ])("rejects malformed replay receipts (%j)", (wire) => {
    expect(() => normalizeInboundReplayResult(wire)).toThrow(/malformed/i);
  });
});

describe("inbound event client requests", () => {
  it("forwards query cancellation to every protected inventory read", async () => {
    const controller = new AbortController();
    await listInboundWebhooks("quality", { signal: controller.signal });
    await getInboundWebhook("endpoint / one", { signal: controller.signal });
    await listInboundTriggers("endpoint / one", {
      signal: controller.signal,
    });
    await listInboundWebhookEvents("endpoint / one", 50, {
      signal: controller.signal,
    });

    expect(mocks.get).toHaveBeenNthCalledWith(1, "/api/v1/inbound-webhooks", {
      query: { query: "quality" },
      signal: controller.signal,
    });
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/inbound-webhooks/endpoint%20%2F%20one",
      { signal: controller.signal },
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      3,
      "/api/v1/inbound-webhooks/endpoint%20%2F%20one/triggers",
      { signal: controller.signal },
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      4,
      "/api/v1/inbound-webhooks/endpoint%20%2F%20one/events",
      { query: { limit: "50" }, signal: controller.signal },
    );
  });

  it("loads the exact bounded event path and normalizes the result", async () => {
    await expect(
      listInboundWebhookEvents("endpoint / one", 50),
    ).resolves.toEqual({
      items: [event],
    });
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/inbound-webhooks/endpoint%20%2F%20one/events",
      { query: { limit: "50" } },
    );
  });

  it("requires an online replay and forwards the caller-stable idempotency key", async () => {
    await expect(
      replayInboundEvent("endpoint / one", 7, "stable-replay-key"),
    ).resolves.toEqual(replay);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/inbound-webhooks/endpoint%20%2F%20one/events/7/replay",
      {},
      {
        requireOnline: true,
        headers: { "Idempotency-Key": "stable-replay-key" },
      },
    );
  });
});
