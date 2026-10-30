// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/lib/mock-mode", () => ({ isMockModeEnabled: () => false }));

import {
  createWebhook,
  deleteWebhook,
  getDelivery,
  listDeliveries,
  listWebhooks,
  reenableWebhook,
  replayDelivery,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
} from "@/lib/webhooks-api";

beforeEach(() => {
  api.get.mockResolvedValue([]);
  api.post.mockResolvedValue({ ok: true });
  api.patch.mockResolvedValue({});
  api.delete.mockResolvedValue({ ok: true });
});

describe("outbound webhook transport authority", () => {
  it("forwards cancellation to every protected read", async () => {
    const controller = new AbortController();
    await listWebhooks({ signal: controller.signal });
    await listDeliveries("hook/a", { limit: 50, signal: controller.signal });
    await getDelivery("hook/a", 7, { signal: controller.signal });

    expect(api.get).toHaveBeenNthCalledWith(1, "/api/v1/webhooks", {
      signal: controller.signal,
    });
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/webhooks/hook%2Fa/deliveries",
      { query: { limit: 50 }, signal: controller.signal },
    );
    expect(api.get).toHaveBeenNthCalledWith(
      3,
      "/api/v1/webhooks/hook%2Fa/deliveries/7",
      { signal: controller.signal },
    );
  });

  it("forces every mutation online with one transport attempt", async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const expectedTransport = {
      requireOnline: true,
      maxAttempts: 1,
      signal: controller.signal,
    };

    await createWebhook(
      { url: "https://hooks.example.test", events: ["subscriber.created"] },
      options,
    );
    await updateWebhook("hook/a", { status: "paused" }, options);
    await reenableWebhook("hook/a", options);
    await rotateWebhookSecret("hook/a", options);
    await testWebhook("hook/a", options);
    await replayDelivery("hook/a", 7, options);
    await deleteWebhook("hook/a", options);

    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/webhooks",
      expect.any(Object),
      expectedTransport,
    );
    expect(api.patch).toHaveBeenCalledWith(
      "/api/v1/webhooks/hook%2Fa",
      { status: "paused" },
      expectedTransport,
    );
    for (const path of [
      "/api/v1/webhooks/hook%2Fa/re-enable",
      "/api/v1/webhooks/hook%2Fa/rotate-secret",
      "/api/v1/webhooks/hook%2Fa/test",
      "/api/v1/webhooks/hook%2Fa/deliveries/7/replay",
    ]) {
      expect(api.post).toHaveBeenCalledWith(path, undefined, expectedTransport);
    }
    expect(api.delete).toHaveBeenCalledWith(
      "/api/v1/webhooks/hook%2Fa",
      expectedTransport,
    );
  });
});
