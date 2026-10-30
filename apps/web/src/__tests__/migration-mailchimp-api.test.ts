import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commit,
  connectWithApiKey,
  discover,
  dryRun,
  getJob,
  listJobs,
  refreshSourceSessionWithApiKey,
  startOAuth,
  startShadowMonitor,
  startSourceEvents,
  stopSourceEvents,
  updateSourceEventReview,
} from "@/lib/migration-api";
import { cancelMigrationJob } from "@/lib/migration-progress-api";

type FetchCall = {
  url: string;
  init: RequestInit;
};

function stubJSONFetch(body: unknown, calls: FetchCall[] = []): FetchCall[] {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function requestBody(call: FetchCall): unknown {
  expect(call.init.body).toBeTypeOf("string");
  return JSON.parse(String(call.init.body));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Mailchimp migration API wrappers", () => {
  it("forwards query cancellation to the migration jobs transport", async () => {
    const calls: FetchCall[] = [];
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (url: string, init: RequestInit) =>
          new Promise<Response>((resolve) => {
            calls.push({ url, init });
            resolveFetch = resolve;
          }),
      ),
    );
    const controller = new AbortController();

    const request = listJobs(controller.signal);
    for (let attempt = 0; attempt < 20 && calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].init.signal?.aborted).toBe(false);
    controller.abort();
    expect(calls[0].init.signal?.aborted).toBe(true);
    resolveFetch(
      new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(request).resolves.toEqual([]);
  });

  it("encodes an opaque job id exactly once in job-scoped paths", async () => {
    const calls = stubJSONFetch({ id: "job/ac?scope=tenant" });

    await getJob("job/ac?scope=tenant");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/job%2Fac%3Fscope%3Dtenant$/,
    );
    expect(calls[0].url).not.toContain("job/ac");
  });

  it("binds an OAuth reconnect to the existing migration job", async () => {
    const calls = stubJSONFetch({
      authorize_url: "https://login.mailchimp.com/oauth2/authorize",
      state: "state_1",
    });

    await startOAuth("mailchimp", "job_existing");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/mailchimp\/oauth\/start\?job_id=job_existing$/,
    );
    expect(calls[0].init.method).toBe("POST");
  });

  it("sends selected audience ids when starting a dry-run", async () => {
    const calls = stubJSONFetch({ job_id: "job_dry" });

    await expect(
      dryRun("mailchimp", "job_source", ["aud_b", "aud_a"]),
    ).resolves.toEqual({ job_id: "job_dry" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/v1\/migrations\/mailchimp\/dry-run$/);
    expect(calls[0].init.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({
      job_id: "job_source",
      selected_audience_ids: ["aud_b", "aud_a"],
    });
  });

  it("sends selected audience ids when repeating scoped discovery", async () => {
    const calls = stubJSONFetch({
      source: "mailchimp",
      subscribers_count: 1,
      segments_count: 0,
      automations_count: 0,
      archive_count: 0,
      paid_subs_count: 0,
      custom_fields: [],
      warnings: [],
    });

    await discover("mailchimp", "job_source", ["aud_primary"]);

    expect(requestBody(calls[0])).toEqual({
      job_id: "job_source",
      selected_audience_ids: ["aud_primary"],
    });
  });

  it("rejects an unscoped Mailchimp dry-run before sending a request", async () => {
    const calls = stubJSONFetch({ job_id: "job_dry" });

    expect(() => dryRun("mailchimp", "job_source")).toThrow(
      "requires at least one explicit audience selection",
    );
    expect(calls).toHaveLength(0);
  });

  it("sends selected audience ids when committing an import", async () => {
    const calls = stubJSONFetch({ job_id: "job_import" });

    await expect(
      commit("mailchimp", "job_dry", ["aud_primary"]),
    ).resolves.toEqual({ job_id: "job_import" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/v1\/migrations\/mailchimp\/commit$/);
    expect(calls[0].init.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({
      job_id: "job_dry",
      selected_audience_ids: ["aud_primary"],
    });
  });

  it("sends ActiveCampaign API URL in both account id and extra credential fields", async () => {
    const calls = stubJSONFetch({
      job_id: "job_ac",
      account_id: "https://acme.api-us1.com/api/3",
    });

    await expect(
      connectWithApiKey(
        "activecampaign",
        "ac_token",
        "https://acme.api-us1.com/api/3",
      ),
    ).resolves.toEqual({
      job_id: "job_ac",
      account_id: "https://acme.api-us1.com/api/3",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/activecampaign\/credentials$/,
    );
    expect(calls[0].init.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({
      api_key: "ac_token",
      account_id: "https://acme.api-us1.com/api/3",
      extra: { api_url: "https://acme.api-us1.com/api/3" },
    });
  });

  it("sends HubSpot hub id in both account id and extra credential fields", async () => {
    const calls = stubJSONFetch({
      job_id: "job_hs",
      account_id: "12345",
    });

    await expect(
      connectWithApiKey("hubspot", "hs_private_token", "12345"),
    ).resolves.toEqual({
      job_id: "job_hs",
      account_id: "12345",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/hubspot\/credentials$/,
    );
    expect(calls[0].init.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({
      api_key: "hs_private_token",
      account_id: "12345",
      extra: { hub_id: "12345" },
    });
  });

  it("binds Beehiiv credentials to the explicit publication in both credential fields", async () => {
    const calls = stubJSONFetch({
      job_id: "job_bh",
      account_id: "pub_1234",
    });

    await expect(
      connectWithApiKey("beehiiv", "bh_secret", "pub_1234"),
    ).resolves.toEqual({
      job_id: "job_bh",
      account_id: "pub_1234",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/beehiiv\/credentials$/,
    );
    expect(requestBody(calls[0])).toEqual({
      api_key: "bh_secret",
      account_id: "pub_1234",
      extra: { publication_id: "pub_1234" },
    });
  });

  it("binds Klaviyo credentials to the optional explicit account", async () => {
    const calls = stubJSONFetch({
      job_id: "job_kl",
      account_id: "account_123",
    });

    await expect(
      connectWithApiKey("klaviyo", "kl_private_key", "account_123"),
    ).resolves.toEqual({
      job_id: "job_kl",
      account_id: "account_123",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/klaviyo\/credentials$/,
    );
    expect(requestBody(calls[0])).toEqual({
      api_key: "kl_private_key",
      account_id: "account_123",
    });
  });

  it("binds Customer.io credentials to an explicit workspace and region", async () => {
    const calls = stubJSONFetch({
      job_id: "job_cio",
      account_id: "9001",
    });

    await expect(
      connectWithApiKey("customerio", "cio_app_key", "9001", {
        region: "eu",
      }),
    ).resolves.toEqual({
      job_id: "job_cio",
      account_id: "9001",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/customerio\/credentials$/,
    );
    expect(requestBody(calls[0])).toEqual({
      api_key: "cio_app_key",
      account_id: "9001",
      extra: { region: "eu" },
    });
  });

  it("refreshes an existing ActiveCampaign source session without creating a new job", async () => {
    const calls = stubJSONFetch({
      id: "job_ac",
      tenant_id: "tenant_a",
      source: "activecampaign",
      status: "completed",
      progress: {},
      cursor: {},
      started_at: "2026-07-01T00:00:00.000Z",
      source_session_expires_at: "2026-09-30T00:00:00.000Z",
    });

    await refreshSourceSessionWithApiKey(
      "job_ac",
      "activecampaign",
      "new_token",
      "https://acme.api-us1.com/api/3",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/job_ac\/source-session$/,
    );
    expect(calls[0].init.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({
      api_key: "new_token",
      account_id: "https://acme.api-us1.com/api/3",
      extra: { api_url: "https://acme.api-us1.com/api/3" },
    });
  });

  it("refreshes an existing HubSpot source session with hub id metadata", async () => {
    const calls = stubJSONFetch({
      id: "job_hs",
      tenant_id: "tenant_a",
      source: "hubspot",
      status: "completed",
      progress: {},
      cursor: {},
      started_at: "2026-07-01T00:00:00.000Z",
      source_session_expires_at: "2026-09-30T00:00:00.000Z",
    });

    await refreshSourceSessionWithApiKey(
      "job_hs",
      "hubspot",
      "new_hs_token",
      "12345",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/job_hs\/source-session$/,
    );
    expect(calls[0].init.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({
      api_key: "new_hs_token",
      account_id: "12345",
      extra: { hub_id: "12345" },
    });
  });

  it("refreshes the same Beehiiv job with its explicit publication binding", async () => {
    const calls = stubJSONFetch({
      id: "job_bh",
      tenant_id: "tenant_a",
      source: "beehiiv",
      status: "completed",
      progress: {},
      cursor: {},
      started_at: "2026-07-01T00:00:00.000Z",
      source_session_expires_at: "2026-09-30T00:00:00.000Z",
    });

    await refreshSourceSessionWithApiKey(
      "job_bh",
      "beehiiv",
      "new_bh_secret",
      "pub_1234",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/job_bh\/source-session$/,
    );
    expect(requestBody(calls[0])).toEqual({
      api_key: "new_bh_secret",
      account_id: "pub_1234",
      extra: { publication_id: "pub_1234" },
    });
  });

  it("refreshes the same Klaviyo job with its account binding", async () => {
    const calls = stubJSONFetch({
      id: "job_kl",
      tenant_id: "tenant_a",
      source: "klaviyo",
      status: "completed",
      progress: {},
      cursor: {},
      started_at: "2026-07-01T00:00:00.000Z",
      source_session_expires_at: "2026-09-30T00:00:00.000Z",
    });

    await refreshSourceSessionWithApiKey(
      "job_kl",
      "klaviyo",
      "new_kl_private_key",
      "account_123",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/job_kl\/source-session$/,
    );
    expect(requestBody(calls[0])).toEqual({
      api_key: "new_kl_private_key",
      account_id: "account_123",
    });
  });

  it("refreshes the same Customer.io workspace and regional session", async () => {
    const calls = stubJSONFetch({
      id: "job_cio",
      tenant_id: "tenant_a",
      source: "customerio",
      status: "completed",
      progress: {},
      cursor: {},
      started_at: "2026-07-01T00:00:00.000Z",
      source_session_expires_at: "2026-10-01T00:00:00.000Z",
    });

    await refreshSourceSessionWithApiKey(
      "job_cio",
      "customerio",
      "new_cio_app_key",
      "9001",
      { region: "eu" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/job_cio\/source-session$/,
    );
    expect(requestBody(calls[0])).toEqual({
      api_key: "new_cio_app_key",
      account_id: "9001",
      extra: { region: "eu" },
    });
  });

  it("uses the unambiguous source-scoped monitor start routes", async () => {
    const calls = stubJSONFetch({ monitor: {}, history: [], events: [] });

    await startShadowMonitor("activecampaign", "job_ac", 900);
    await startSourceEvents("klaviyo", "job_kl", 1200);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/sources\/activecampaign\/shadow-monitor$/,
    );
    expect(calls[0].init.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({
      job_id: "job_ac",
      interval_seconds: 900,
    });
    expect(calls[1].url).toMatch(
      /\/api\/v1\/migrations\/sources\/klaviyo\/source-events$/,
    );
    expect(calls[1].init.method).toBe("POST");
    expect(requestBody(calls[1])).toEqual({
      job_id: "job_kl",
      interval_seconds: 1200,
    });
  });

  it("keeps ordinary source-event stop separate from explicit HubSpot post-pilot cleanup", async () => {
    const calls = stubJSONFetch({
      job_id: "job_hs",
      enabled: false,
      source_session_cleared: false,
    });

    await stopSourceEvents("job_hs");
    await stopSourceEvents("job_hs", true);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/job_hs\/source-events$/,
    );
    expect(calls[0].url).not.toContain("post_pilot_cleanup");
    expect(calls[1].url).toMatch(
      /\/api\/v1\/migrations\/job_hs\/source-events\?post_pilot_cleanup=1$/,
    );
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[1].init.method).toBe("DELETE");
  });

  it("records row-level source-event review evidence on the job-scoped route", async () => {
    const calls = stubJSONFetch({
      id: "event/result 1",
      review_status: "reviewed",
      applied: false,
    });

    await updateSourceEventReview("job/ac", "event/result 1", {
      status: "reviewed",
      detail: "Phone-only contact reconciled.",
      evidence: ["cutover-ticket-42"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/v1\/migrations\/job%2Fac\/source-events\/event%2Fresult%201\/review$/,
    );
    expect(calls[0].init.method).toBe("PATCH");
    expect(requestBody(calls[0])).toEqual({
      status: "reviewed",
      detail: "Phone-only contact reconciled.",
      evidence: ["cutover-ticket-42"],
    });
  });

  it("keeps every allow-listed cutover evidence key and label in sync", async () => {
    vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "1");
    vi.resetModules();
    const { CUTOVER_EVIDENCE_KEYS, recordCutoverEvidence } =
      await import("@/lib/migration-api");
    const expected = [
      [
        "activecampaign_consent_exclusion_review",
        "ActiveCampaign consent/exclusion/contact-identity review",
      ],
      [
        "activecampaign_deliverability_review",
        "ActiveCampaign deliverability review",
      ],
      [
        "activecampaign_automation_rebuild_review",
        "ActiveCampaign automation rebuild review",
      ],
      ["activecampaign_segments_review", "ActiveCampaign segment review"],
      [
        "activecampaign_audience_schema_review",
        "ActiveCampaign audience field/tag schema review",
      ],
      [
        "activecampaign_campaign_archive_fidelity_review",
        "ActiveCampaign campaign archive fidelity review",
      ],
      [
        "activecampaign_templates_review",
        "ActiveCampaign templates/messages review",
      ],
      ["activecampaign_forms_review", "ActiveCampaign forms review"],
      [
        "activecampaign_custom_objects_review",
        "ActiveCampaign custom objects review",
      ],
      ["activecampaign_ecommerce_review", "ActiveCampaign ecommerce review"],
      [
        "activecampaign_crm_archive_review",
        "ActiveCampaign CRM archive review",
      ],
      [
        "activecampaign_post_pilot_cleanup",
        "ActiveCampaign post-pilot credential cleanup authorization",
      ],
      [
        "beehiiv_consent_reconciliation",
        "Beehiiv consent and suppression reconciliation",
      ],
      ["beehiiv_segment_rules_review", "Beehiiv dynamic segment rules review"],
      [
        "beehiiv_campaign_archive_fidelity",
        "Beehiiv campaign archive fidelity review",
      ],
      [
        "beehiiv_automation_retirement_review",
        "Beehiiv source-automation retirement review",
      ],
      [
        "beehiiv_website_capture_rebuild_review",
        "Beehiiv website/theme/capture rebuild review",
      ],
      [
        "beehiiv_boosts_recommendations_rebuild_review",
        "Beehiiv Boosts/recommendations rebuild review",
      ],
      ["beehiiv_ad_network_review", "Beehiiv Ad Network review"],
      [
        "klaviyo_consent_suppression_review",
        "Klaviyo profile identity, consent, and suppression review",
      ],
      [
        "klaviyo_audience_snapshot_review",
        "Klaviyo list and segment snapshot review",
      ],
      ["klaviyo_flow_rebuild_review", "Klaviyo flow rebuild review"],
      [
        "klaviyo_channel_identity_review",
        "Klaviyo channel identity and sender review",
      ],
      ["klaviyo_deliverability_review", "Klaviyo deliverability review"],
      [
        "klaviyo_ecosystem_dependencies_review",
        "Klaviyo ecosystem dependency review",
      ],
      [
        "customerio_consent_subscription_review",
        "Customer.io consent and subscription review",
      ],
      [
        "customerio_identity_audience_review",
        "Customer.io profile identity and audience review",
      ],
      [
        "customerio_automation_rebuild_review",
        "Customer.io campaign and broadcast rebuild review",
      ],
      [
        "customerio_channel_dependency_review",
        "Customer.io channel identity and dependency review",
      ],
      ["customerio_deliverability_review", "Customer.io deliverability review"],
      [
        "customerio_ecosystem_dependencies_review",
        "Customer.io ecosystem dependency review",
      ],
      ["hubspot_crm_bridge_scope_review", "HubSpot CRM-bridge scope review"],
      [
        "hubspot_post_pilot_cleanup",
        "HubSpot post-pilot source-session cleanup authorization",
      ],
      ["sms_readiness", "SMS pilot readiness"],
      ["source_discovery_warnings", "Source discovery warnings"],
      ["source_archive_warnings", "Source archive warnings"],
    ] as const;

    expect(CUTOVER_EVIDENCE_KEYS).toEqual(expected.map(([key]) => key));

    for (const [key, label] of expected) {
      const keyedReport = await recordCutoverEvidence("job_ac", {
        key,
        evidence: [`${label} evidence attached.`],
      });
      expect(keyedReport.items[0]).toMatchObject({
        key,
        label,
        status: "pass",
        evidence: [`${label} evidence attached.`],
      });
    }
  });

  it("preserves rollback metadata returned by cancel", async () => {
    const rollbackUntil = "2026-07-09T00:00:00.000Z";
    const calls = stubJSONFetch({
      job_id: "job_import",
      cancelled: true,
      status: "failed",
      rollback_available: true,
      rollback_until: rollbackUntil,
      progress: {
        subscribers_total: 10,
        subscribers_done: 4,
        segments_total: 0,
        segments_done: 0,
        automations_total: 0,
        automations_done: 0,
        paid_subs_total: 0,
        paid_subs_done: 0,
        archive_total: 0,
        archive_done: 0,
        templates_total: 2,
        templates_done: 1,
        source_archive_total: 3,
        source_archive_done: 2,
      },
    });

    const result = await cancelMigrationJob("job_import");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/v1\/migrations\/job_import$/);
    expect(calls[0].init.method).toBe("DELETE");
    expect(result.rollback_available).toBe(true);
    expect(result.rollback_until).toBe(rollbackUntil);
    expect(result.progress?.templates_done).toBe(1);
    expect(result.progress?.source_archive_done).toBe(2);
  });
});
