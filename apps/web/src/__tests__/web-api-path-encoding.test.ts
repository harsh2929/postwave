import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluateAB } from "@/lib/abtests-api";
import { api } from "@/lib/api";
import { revokeApiKey } from "@/lib/api-keys-api";
import { oauthLinkStartUrl, oauthStartUrl } from "@/lib/auth-api";
import { commerceApi } from "@/lib/commerce-api";
import { deleteForm } from "@/lib/forms-api";
import { slackIntegrationsApi } from "@/lib/integrations-api";
import {
  listCompatResources,
  mailchimpCompatPath,
} from "@/lib/mailchimp-compat-api";
import { deleteTopic } from "@/lib/preferences-api";
import { deleteSegment } from "@/lib/segments-api";
import { removeSource } from "@/lib/voice-api";
import { deleteWebhook } from "@/lib/webhooks-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web API dynamic path encoding", () => {
  it("encodes path IDs before placing them into API routes", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await deleteWebhook("hook/a");
    await deleteTopic("topic/a");
    await evaluateAB("campaign/a");
    await removeSource("source/a");
    await deleteForm("form/a");
    await revokeApiKey("key/a");
    await deleteSegment("segment/a");
    await listCompatResources("ecommerce/integrations");
    await slackIntegrationsApi.delete("slack/a");
    await commerceApi.events("commerce/a");

    expect(calls).toEqual([
      "http://localhost:8080/api/v1/webhooks/hook%2Fa",
      "http://localhost:8080/api/v1/topics/topic%2Fa",
      "http://localhost:8080/api/v1/campaigns/campaign%2Fa/ab/evaluate",
      "http://localhost:8080/api/v1/voice/sources/source%2Fa",
      "http://localhost:8080/api/v1/forms/form%2Fa",
      "http://localhost:8080/api/v1/api-keys/key%2Fa",
      "http://localhost:8080/api/v1/segments/segment%2Fa",
      "http://localhost:8080/api/v1/mailchimp-compat/ecommerce/integrations",
      "http://localhost:8080/api/v1/integrations/slack/slack%2Fa",
      "http://localhost:8080/api/v1/commerce/integrations/commerce%2Fa/events",
    ]);
  });

  it("guards deliberate path-like helpers without allowing traversal", () => {
    expect(mailchimpCompatPath("ecommerce/integrations")).toBe(
      "ecommerce/integrations",
    );
    expect(mailchimpCompatPath("landing pages")).toBe("landing%20pages");
    expect(() => mailchimpCompatPath("../admin")).toThrow(/Invalid/);
    expect(() => mailchimpCompatPath("/admin")).toThrow(/Invalid/);
    expect(() => mailchimpCompatPath("admin//users")).toThrow(/Invalid/);

    expect(oauthStartUrl("google", "/app/settings")).toBe(
      "/api/v1/auth/oauth/google/start?redirect_to=%2Fapp%2Fsettings",
    );
    expect(oauthStartUrl("google", `/${"x".repeat(3000)}`)).toBe(
      "/api/v1/auth/oauth/google/start?redirect_to=%2Fapp",
    );
    expect(oauthStartUrl("google", "//evil.example/app")).toBe(
      "/api/v1/auth/oauth/google/start?redirect_to=%2Fapp",
    );
    expect(oauthLinkStartUrl("google", "/app/settings/security")).toBe(
      "/api/v1/auth/oauth/google/start?redirect_to=%2Fapp%2Fsettings%2Fsecurity&link=true",
    );
    expect(oauthLinkStartUrl("google", "https://evil.example/callback")).toBe(
      "/api/v1/auth/oauth/google/start?redirect_to=%2Fapp&link=true",
    );
  });

  it("rejects absolute and traversal API paths before fetch", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetch);

    await expect(api.get("https://evil.example/api/v1/me")).rejects.toThrow(
      /Unsafe API path/,
    );
    await expect(api.get("/api/v1/subscribers/../admin")).rejects.toThrow(
      /Unsafe API path/,
    );
    await expect(api.get("/api/v1/%2e%2e/admin")).rejects.toThrow(
      /Unsafe API path/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
