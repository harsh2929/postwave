import { afterEach, describe, expect, it, vi } from "vitest";

import { ALL_API_KEY_SCOPES, rotateApiKey } from "@/lib/api-keys-api";
import { verifyCustomDomain } from "@/lib/custom-domains-api";
import { reenableWebhook } from "@/lib/webhooks-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings governance API contracts", () => {
  it("offers every backend audit scope", () => {
    const scopes = new Set(ALL_API_KEY_SCOPES.map((scope) => scope.value));
    for (const scope of [
      "audit:read",
      "audit:read_pii",
      "audit:read_all_tenants",
      "audit:configure_sinks",
      "audit:configure_retention",
      "audit:execute_actions",
    ]) {
      expect(scopes.has(scope as never)).toBe(true);
    }
  });

  it("rotates keys and re-enables webhooks through their lifecycle endpoints", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.includes("api-keys")) {
          return Response.json(
            {
              key: {
                id: "key-new",
                tenantId: "tenant-1",
                label: "CI",
                prefix: "pw_live_new",
                scopes: ["read:reports"],
                createdAt: "2026-07-10T00:00:00Z",
              },
              plaintext: "pw_live_new_secret",
              revoked_id: "key/old",
            },
            { status: 201 },
          );
        }
        return Response.json({ ok: true });
      }),
    );

    await rotateApiKey("key/old");
    await reenableWebhook("hook/paused");

    expect(calls).toEqual([
      {
        url: "http://localhost:8080/api/v1/api-keys/key%2Fold/rotate",
        method: "POST",
      },
      {
        url: "http://localhost:8080/api/v1/webhooks/hook%2Fpaused/re-enable",
        method: "POST",
      },
    ]);
  });

  it("holds DNS verification before transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyCustomDomain("domain-1")).rejects.toMatchObject(
      expect.objectContaining({
        code: "custom_domain_verification_unavailable",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
