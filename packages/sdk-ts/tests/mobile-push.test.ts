import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

const deviceKey = "a".repeat(64);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("MobilePushResource", () => {
  it("uses the session-scoped registration, status, and revocation routes", async () => {
    const fetch = vi.fn(async () =>
      json({ registered: true, delivery_enabled: true }),
    );
    const client = new PostwaveClient({
      authMode: "session",
      credentials: "include",
      fetch,
      retries: 0,
    });

    await client.mobilePush.register({
      device_key: deviceKey,
      expo_push_token: "ExponentPushToken[test-device]",
      platform: "ios",
      enabled_events: ["approval.requested"],
    });
    await client.mobilePush.status({ device_key: deviceKey });
    await client.mobilePush.revoke({ device_key: deviceKey });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.moosewave.com/api/v1/mobile/push/devices",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          device_key: deviceKey,
          expo_push_token: "ExponentPushToken[test-device]",
          platform: "ios",
          enabled_events: ["approval.requested"],
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.moosewave.com/api/v1/mobile/push/devices/status",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ device_key: deviceKey }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "https://api.moosewave.com/api/v1/mobile/push/devices/revoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ device_key: deviceKey }),
      }),
    );
  });

  it("supports non-enumerating possession revocation after logout", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new PostwaveClient({
      authMode: "none",
      fetch,
      retries: 0,
    });

    await client.mobilePush.revokePossession({ device_key: deviceKey });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/public/mobile/push/revoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ device_key: deviceKey }),
        headers: expect.not.objectContaining({
          Authorization: expect.anything(),
        }),
      }),
    );
  });
});
