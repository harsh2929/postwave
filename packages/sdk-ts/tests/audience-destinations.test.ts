import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AudienceDestinationsResource", () => {
  it("routes ad audience destination lifecycle calls to first-party endpoints", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (init?.method === "DELETE") {
        return json({
          ok: true,
          provider_cleanup: {
            provider: "meta",
            status: "operator_action_required",
            postwave_status: "disconnected",
            provider_cleanup_posture: "operator_managed_provider_console",
            managed_provider_cleanup: false,
            audience_cleanup_status: "operator_review_required",
            audience_membership_cleanup_status: "postwave_delivery_stopped",
            credential_cleanup_status: "operator_revoke_or_rotate_if_no_longer_used",
          },
        });
      }
      return json({
        id: "aud/1",
        provider: "meta",
        status: "active",
        items: [],
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.audienceDestinations.providers();
    await pw.audienceDestinations.list();
    await pw.audienceDestinations.list("meta");
    await pw.audienceDestinations.create({
      provider: "meta",
      list_id: "list_123",
      external_audience_id: "act_123",
      config: { credentials_ref: "vault://meta" },
    });
    await pw.audienceDestinations.get("aud/1");
    await pw.audienceDestinations.update("aud/1", {
      status: "paused",
      config: { credentials_ref: "vault://meta-rotated" },
    });
    await pw.audienceDestinations.readiness("meta", {
      audience_id: "audience_123",
    });
    await pw.audienceDestinations.preview("aud/1");
    await pw.audienceDestinations.sync("aud/1");
    await pw.audienceDestinations.jobs("aud/1");
    await pw.audienceDestinations.jobDiagnostics("aud/1", "job/1");
    const disconnected = await pw.audienceDestinations.disconnect("aud/1");
    expect(disconnected.provider_cleanup?.managed_provider_cleanup).toBe(false);

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations/providers",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations?provider=meta",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations",
        method: "POST",
        body: {
          provider: "meta",
          list_id: "list_123",
          external_audience_id: "act_123",
          config: { credentials_ref: "vault://meta" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations/aud%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations/aud%2F1",
        method: "PATCH",
        body: {
          status: "paused",
          config: { credentials_ref: "vault://meta-rotated" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations/meta/readiness",
        method: "POST",
        body: { config: { audience_id: "audience_123" } },
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations/aud%2F1/preview",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations/aud%2F1/sync",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations/aud%2F1/jobs",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations/aud%2F1/jobs/job%2F1/diagnostics",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-destinations/aud%2F1",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("guards empty destination identifiers and providers before fetch", async () => {
    const fetch = vi.fn(async () => json({}));
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    expect(() => pw.audienceDestinations.get(" ")).toThrow(
      /audience destination id is required/,
    );
    expect(() => pw.audienceDestinations.readiness(" ")).toThrow(
      /audience destination provider is required/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
