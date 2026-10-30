import { describe, it, expect, vi } from "vitest";
import { PostwaveClient } from "../src/index.js";

function mockFetch(
  handler: (req: {
    url: string;
    init: RequestInit;
  }) => Response | Promise<Response>,
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    return handler({ url, init: init ?? {} });
  });
}

describe("PostwaveClient — happy path", () => {
  it("sends Bearer + tenant headers and parses JSON response", async () => {
    const fetch = mockFetch(({ url, init }) => {
      expect(url).toBe("https://api.moosewave.com/api/v1/me");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer sk_test_123",
      );
      expect((init.headers as Record<string, string>)["X-Tenant-Slug"]).toBe(
        "acme",
      );
      return new Response(
        JSON.stringify({ tenant: "acme", user: "founder@acme.com" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const pw = new PostwaveClient({
      apiKey: "sk_test_123",
      tenantId: "acme",
      fetch,
      retries: 0,
    });
    const me = await pw.request<{ tenant: string; user: string | null }>(
      "GET",
      "/api/v1/me",
    );
    expect(me).toEqual({ tenant: "acme", user: "founder@acme.com" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("supports cookie-session auth without an Authorization header", async () => {
    const fetch = mockFetch(({ url, init }) => {
      expect(url).toBe("https://api.moosewave.com/api/v1/subscribers?page=1");
      expect(
        (init.headers as Record<string, string>)["Authorization"],
      ).toBeUndefined();
      expect((init.headers as Record<string, string>)["X-Tenant-Slug"]).toBe(
        "acme",
      );
      expect(init.credentials).toBe("include");
      return new Response(
        JSON.stringify({ items: [], total: 0, page: 1, per_page: 50 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const pw = new PostwaveClient({
      authMode: "session",
      credentials: "include",
      tenantId: "92b5515c-75f7-4c85-9129-83d40e1c15cf",
      tenantSlug: "acme",
      fetch,
      retries: 0,
    });
    await expect(pw.subscribers.list({ page: 1 })).resolves.toMatchObject({
      items: [],
      total: 0,
    });
  });

  it("never mislabels a session tenant UUID as X-Tenant-Slug", async () => {
    const fetch = mockFetch(({ init }) => {
      expect(
        (init.headers as Record<string, string>)["X-Tenant-Slug"],
      ).toBeUndefined();
      return new Response(
        JSON.stringify({ items: [], total: 0, page: 1, per_page: 50 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const pw = new PostwaveClient({
      authMode: "session",
      tenantId: "92b5515c-75f7-4c85-9129-83d40e1c15cf",
      credentials: "include",
      fetch,
      retries: 0,
    });

    await expect(pw.subscribers.list()).resolves.toMatchObject({ items: [] });
  });

  it("subscribers.list serializes query params", async () => {
    const fetch = mockFetch(({ url }) => {
      expect(url).toContain("/api/v1/subscribers?");
      expect(url).toContain("page=2");
      expect(url).toContain("per_page=25");
      expect(url).toContain("q=alice%40example.com");
      expect(url).toContain("status=disabled");
      return new Response(
        JSON.stringify({ items: [], total: 0, page: 2, per_page: 25 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });
    const page = await pw.subscribers.list({
      page: 2,
      per_page: 25,
      q: "alice@example.com",
      status: "disabled",
    });
    expect(page.total).toBe(0);
  });

  it("preserves deployment base paths and treats absolute-looking paths as relative", async () => {
    const seen: string[] = [];
    const fetch = mockFetch(({ url }) => {
      seen.push(url);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      baseUrl: "https://api.example.test/gateway///",
      fetch,
      retries: 0,
    });

    await pw.request("GET", "api/v1/me", { query: { expand: true } });

    expect(seen).toEqual([
      "https://api.example.test/gateway/api/v1/me?expand=true",
    ]);
  });

  it("rejects unsafe SDK base URLs and request paths", async () => {
    const fetch = mockFetch(() => new Response(JSON.stringify({ ok: true })));
    expect(
      () =>
        new PostwaveClient({
          apiKey: "k",
          baseUrl: "http://api.example.test",
          fetch,
        }),
    ).toThrow(/baseUrl must be a valid/);
    expect(
      () =>
        new PostwaveClient({
          apiKey: "k",
          baseUrl: "https://api.example.test/\nmalformed",
          fetch,
        }),
    ).toThrow(/baseUrl must be a valid/);
    expect(
      () =>
        new PostwaveClient({
          apiKey: "k\nx",
          fetch,
        }),
    ).toThrow(/apiKey contains unsafe/);
    expect(
      () =>
        new PostwaveClient({
          apiKey: "k",
          tenantId: "tenant\nx",
          fetch,
        }),
    ).toThrow(/tenantId contains unsafe/);
    expect(
      () =>
        new PostwaveClient({
          apiKey: "k",
          baseUrl: "https://user:pass@api.example.test",
          fetch,
        }),
    ).toThrow(/baseUrl must be a valid/);

    const pw = new PostwaveClient({
      apiKey: "k",
      fetch,
      retries: 0,
    });
    await expect(pw.request("GET", "../api/v1/me")).rejects.toThrow(
      /unsafe request path/,
    );
    await expect(
      pw.request("GET", "https://evil.example/api/v1/me"),
    ).rejects.toThrow(/unsafe request path/);
    await expect(pw.request("GET", "/api/v1/%2e%2e/admin")).rejects.toThrow(
      /unsafe request path/,
    );
    await expect(pw.request("GET", "/api/v1/%252e%252e/admin")).rejects.toThrow(
      /unsafe request path/,
    );
    await expect(pw.request("GET", "/api/v1/bad\\path")).rejects.toThrow(
      /unsafe request path/,
    );
  });

  it("allows localhost HTTP base URLs for local development", async () => {
    const fetch = mockFetch(({ url }) => {
      expect(url).toBe("http://localhost:8080/api/v1/me");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      baseUrl: "http://localhost:8080///",
      fetch,
      retries: 0,
    });

    await expect(pw.request("GET", "/api/v1/me")).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects unsafe caller-provided headers before fetch", async () => {
    const fetch = mockFetch(() => new Response(JSON.stringify({ ok: true })));
    const pw = new PostwaveClient({
      apiKey: "k",
      fetch,
      retries: 0,
    });

    await expect(
      pw.request("GET", "/api/v1/me", { headers: { "X-Bad\nName": "x" } }),
    ).rejects.toThrow(/unsafe request header name/);
    await expect(
      pw.request("GET", "/api/v1/me", { headers: { "X-Good": "x\ny" } }),
    ).rejects.toThrow(/unsafe request header value/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns undefined for 204 No Content", async () => {
    const fetch = mockFetch(() => new Response(null, { status: 204 }));
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });
    await expect(pw.subscribers.delete("s_1")).resolves.toBeUndefined();
  });

  it("submits a JSON body and returns the parsed result", async () => {
    const fetch = mockFetch(({ init }) => {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ template_id: "tpl_welcome_3", name: "Welcome" });
      return new Response(
        JSON.stringify({
          id: "seq_1",
          tenant_id: "acme",
          template_id: "tpl_welcome_3",
          name: "Welcome",
          emails: [],
          created_at: "2026-04-30T10:00:00Z",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "acme",
      fetch,
      retries: 0,
    });
    const seq = await pw.sequences.generate({
      template_id: "tpl_welcome_3",
      name: "Welcome",
    });
    // The synchronous-mode response is a full Sequence; the async-mode
    // response is a SequenceJobAck. Narrow before asserting.
    if ("job_id" in seq) {
      throw new Error("expected synchronous Sequence, got job ack");
    }
    expect(seq.id).toBe("seq_1");
  });

  it("updates and deletes generated sequences with strong revision guards", async () => {
    const calls: Array<{
      url: string;
      method?: string;
      body?: unknown;
      ifMatch?: string;
    }> = [];
    const fetch = mockFetch(({ url, init }) => {
      calls.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        ifMatch: (init.headers as Record<string, string>)["If-Match"],
      });
      if (init.method === "PATCH") {
        return new Response(
          JSON.stringify({
            id: "seq_1",
            tenant_id: "acme",
            template_id: "tpl_welcome_3",
            name: "After",
            status: "draft",
            version: 8,
            emails: [],
            created_at: "2026-04-30T10:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "acme",
      fetch,
      retries: 0,
    });
    await expect(
      pw.sequences.update("seq_1", { name: "After" }, 7),
    ).resolves.toMatchObject({
      id: "seq_1",
      name: "After",
    });
    await expect(pw.sequences.delete("seq_1", 8)).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/voice/sequences/seq_1",
        method: "PATCH",
        body: { name: "After" },
        ifMatch: '"7"',
      },
      {
        url: "https://api.moosewave.com/api/v1/voice/sequences/seq_1",
        method: "DELETE",
        body: undefined,
        ifMatch: '"8"',
      },
    ]);

    expect(() => pw.sequences.update("seq_1", { name: "Unsafe" }, 0)).toThrow(
      /positive safe integer/,
    );
    expect(() => pw.sequences.delete("seq_1", Number.NaN)).toThrow(
      /positive safe integer/,
    );
    expect(calls).toHaveLength(2);
  });

  it("updates and deletes voice templates", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = mockFetch(({ url, init }) => {
      calls.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (init.method === "PATCH") {
        return new Response(
          JSON.stringify({
            id: "tpl_1",
            slug: "welcome",
            category: "welcome",
            name: "After",
            description: "",
            length: 1,
            variables: [],
            emails: [],
            tags: [],
            author: "",
            performance: {
              open_rate: 0,
              click_rate: 0,
              conversion_rate: 0,
              sample_size: 0,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "acme",
      fetch,
      retries: 0,
    });
    await expect(
      pw.templates.update("tpl_1", { name: "After" }),
    ).resolves.toMatchObject({
      id: "tpl_1",
      name: "After",
    });
    await expect(pw.templates.delete("tpl_1")).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/voice/templates/tpl_1",
        method: "PATCH",
        body: { name: "After" },
      },
      {
        url: "https://api.moosewave.com/api/v1/voice/templates/tpl_1",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("queues campaign sends with sandbox header when requested", async () => {
    const fetch = mockFetch(({ url, init }) => {
      expect(url).toBe("https://api.moosewave.com/api/v1/campaigns/cmp_1/queue");
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Postwave-Sandbox"]).toBe("true");
      return new Response(
        JSON.stringify({
          campaign_id: "cmp_1",
          recipients_queued: 12,
          status: "sending",
          sandbox: true,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "acme",
      fetch,
      retries: 0,
    });
    await expect(
      pw.campaigns.queue("cmp_1", { sandbox: true }),
    ).resolves.toMatchObject({
      campaign_id: "cmp_1",
      recipients_queued: 12,
      sandbox: true,
    });
  });

  it("surfaces campaign approval-required responses from immediate send", async () => {
    const fetch = mockFetch(({ url }) => {
      expect(url).toBe("https://api.moosewave.com/api/v1/campaigns/cmp_2/send");
      return new Response(
        JSON.stringify({
          campaign_id: "cmp_2",
          recipients_queued: 0,
          status: "approval_required",
          approval_id: "apr_1",
          approval_status: "pending",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "acme",
      fetch,
      retries: 0,
    });
    await expect(pw.campaigns.send("cmp_2")).resolves.toMatchObject({
      status: "approval_required",
      approval_id: "apr_1",
    });
  });

  it("routes segment updates and SMS public-contract calls", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = mockFetch(({ url, init }) => {
      calls.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "acme",
      fetch,
      retries: 0,
    });

    await pw.segments.update("segment/a", { name: "After" });
    await pw.sms.setup();
    await pw.sms.createList({ name: "VIP" });
    await pw.sms.upsertSender({ provider: "twilio" });
    for (const unsafeSender of [
      { brand_registration_sid: "BN_PRIVATE" },
      { campaign_registration_sid: "QE_PRIVATE" },
      { registration_status: "approved" },
    ]) {
      await expect(
        pw.sms.upsertSender(unsafeSender as never),
      ).rejects.toMatchObject({
        status: 409,
        code: "sms_registration_evidence_authority_required",
      });
    }
    await pw.sms.pauseSender("sender/a", "maintenance");
    await pw.sms.resumeSender("sender/a");
    await expect(
      pw.sms.submitBrandRegistration("sender/private", {
        company_name: "Private Acme",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "sms_a2p_registration_release_held",
    });
    await expect(
      pw.sms.submitCampaignRegistration("sender/private", {
        description: "Private alerts",
        message_flow: "Private flow",
        message_samples: ["Private sample"],
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "sms_a2p_registration_release_held",
    });
    await expect(
      pw.sms.pollA2PRegistration("sender/private"),
    ).rejects.toMatchObject({
      status: 503,
      code: "sms_a2p_registration_release_held",
    });
    for (const action of ["granted", "imported", "help_requested"]) {
      await expect(
        pw.sms.recordConsent({
          phone_e164: "+14155551212",
          action,
          source: "manual",
          proof_text: "private proof that must not leave the process",
        } as never),
      ).rejects.toMatchObject({
        code:
          action === "granted"
            ? "carrier_resubscribe_authority_required"
            : "invalid_consent_action",
      });
    }
    expect(calls.some((call) => call.url.endsWith("/sms/consent"))).toBe(false);
    await pw.sms.recordConsent({
      phone_e164: "+14155551212",
      action: "revoked",
      source: "manual",
      proof_text: "Operator revocation request",
    });
    await pw.sms.createCampaign({ name: "Launch", body: "Hi" });
    await expect(
      pw.sms.createCampaign({
        name: "Private scheduled campaign",
        body: "Private body",
        status: "scheduled",
        scheduled_at: "2026-08-23T12:00:00Z",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "sms_campaign_schedule_release_held",
    });
    const confidentialCampaignId = "campaign/+14155551212/private";
    await expect(
      pw.sms.campaignReport(confidentialCampaignId),
    ).rejects.toMatchObject({
      status: 503,
      code: "sms_evidence_read_release_held",
    });
    await expect(
      pw.sms.exportCampaignReport(confidentialCampaignId, {
        status: "failed",
        limit: 10,
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "sms_evidence_read_release_held",
    });
    const heldError = await pw.sms
      .campaignReport(confidentialCampaignId)
      .catch((error: unknown) => error);
    expect(String(heldError)).not.toContain(confidentialCampaignId);
    expect(String(heldError)).not.toContain("+14155551212");
    await expect(
      pw.sms.sendCampaign("campaign/private", { limit: 5 }),
    ).rejects.toMatchObject({
      status: 503,
      code: "sms_campaign_dispatch_release_held",
    });
    await expect(
      pw.sms.scheduleCampaign("campaign/private", "2026-05-19T12:00:00Z"),
    ).rejects.toMatchObject({
      status: 503,
      code: "sms_campaign_schedule_release_held",
    });
    await pw.sms.pauseCampaign("campaign/a");
    await expect(
      pw.sms.resumeCampaign("campaign/private"),
    ).rejects.toMatchObject({
      status: 503,
      code: "sms_campaign_resume_release_held",
    });
    await pw.sms.cancelCampaign("campaign/a");
    await expect(
      pw.sms.sendTest({
        sender_profile_id: "sender/private",
        list_id: "list/private",
        to: "+14155551212",
        body: "Private test body",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "sms_test_dispatch_release_held",
    });
    expect(JSON.stringify(calls)).not.toContain("Private");
    expect(JSON.stringify(calls)).not.toContain("sender/private");
    expect(JSON.stringify(calls)).not.toContain("campaign/private");

    expect(calls).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/segments/segment%2Fa",
        method: "PATCH",
        body: { name: "After" },
      },
      {
        url: "https://api.moosewave.com/api/v1/sms/setup",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/sms/lists",
        method: "POST",
        body: { name: "VIP" },
      },
      {
        url: "https://api.moosewave.com/api/v1/sms/senders",
        method: "POST",
        body: { provider: "twilio" },
      },
      {
        url: "https://api.moosewave.com/api/v1/sms/senders/sender%2Fa/pause",
        method: "POST",
        body: { reason: "maintenance" },
      },
      {
        url: "https://api.moosewave.com/api/v1/sms/senders/sender%2Fa/resume",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.moosewave.com/api/v1/sms/consent",
        method: "POST",
        body: {
          phone_e164: "+14155551212",
          action: "revoked",
          source: "manual",
          proof_text: "Operator revocation request",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/sms/campaigns",
        method: "POST",
        body: { name: "Launch", body: "Hi" },
      },
      {
        url: "https://api.moosewave.com/api/v1/sms/campaigns/campaign%2Fa/pause",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.moosewave.com/api/v1/sms/campaigns/campaign%2Fa/cancel",
        method: "POST",
        body: {},
      },
    ]);
  });
});
