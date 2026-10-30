// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchWebPushConfig,
  serializeSubscription,
  urlBase64ToUint8Array,
} from "@/lib/web-push";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("urlBase64ToUint8Array", () => {
  it("decodes a base64url VAPID key (no padding) into bytes", () => {
    // "hello" -> base64 "aGVsbG8=" -> base64url "aGVsbG8" (padding stripped)
    const bytes = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });

  it("handles base64url -_ alphabet", () => {
    // 0xFB 0xFF 0xBF -> base64 "+/+/" -> base64url "-_-_"
    const bytes = urlBase64ToUint8Array("-_-_");
    expect(Array.from(bytes)).toEqual([0xfb, 0xff, 0xbf]);
  });
});

describe("serializeSubscription", () => {
  it("flattens a PushSubscription into the backend wire shape", () => {
    const fake = {
      endpoint: "https://push.example/abc",
      expirationTime: null,
      toJSON: () => ({
        endpoint: "https://push.example/abc",
        keys: { p256dh: "PKEY", auth: "AUTH" },
      }),
    } as unknown as PushSubscription;

    expect(serializeSubscription(fake)).toEqual({
      endpoint: "https://push.example/abc",
      keys: { p256dh: "PKEY", auth: "AUTH" },
      expiration_time: null,
    });
  });

  it("tolerates a subscription with missing keys", () => {
    const fake = {
      endpoint: "https://push.example/x",
      expirationTime: 123,
      toJSON: () => ({ endpoint: "https://push.example/x" }),
    } as unknown as PushSubscription;

    expect(serializeSubscription(fake)).toEqual({
      endpoint: "https://push.example/x",
      keys: { p256dh: "", auth: "" },
      expiration_time: 123,
    });
  });
});

describe("fetchWebPushConfig", () => {
  it("reports disabled when neither API nor env VAPID config is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "");

    const { fetchWebPushConfig: freshFetchWebPushConfig } = await import(
      "@/lib/web-push"
    );

    await expect(freshFetchWebPushConfig()).resolves.toEqual({
      enabled: false,
      publicKey: "",
    });
  });

  it("uses the API-provided public key when enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ enabled: true, public_key: "api-key" }),
      ),
    );

    // Prime through the static import too, so the export remains referenced.
    expect(typeof fetchWebPushConfig).toBe("function");
    const { fetchWebPushConfig: freshFetchWebPushConfig } = await import(
      "@/lib/web-push"
    );

    await expect(freshFetchWebPushConfig()).resolves.toEqual({
      enabled: true,
      publicKey: "api-key",
    });
  });
});
