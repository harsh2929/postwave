import { describe, expect, it, vi } from "vitest";
import { PostwaveClient, type FactContractV1 } from "../src/index.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const findingId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";
const planId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";

const measurement = {
  name: "Predicted Agent Comprehension",
  interpretation:
    "A versioned prediction; it is not an inbox provider's actual summary.",
  source_classes: [
    {
      class: "deterministic",
      present: true,
      meaning: "versioned rule-based analysis",
    },
    {
      class: "modeled",
      present: false,
      meaning: "modeled prediction, not private inbox observation",
    },
    {
      class: "controlled_observation",
      present: false,
      meaning: "named controlled seed environment only",
    },
  ],
} as const;

describe("CampaignAssuranceResource", () => {
  it("sets the typed Fact Contract with exact concurrency and returns the next ETag", async () => {
    let request:
      | {
          method: string;
          url: string;
          headers: Record<string, string>;
          body: string;
        }
      | undefined;
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      request = {
        method: String(init.method),
        url,
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      };
      return new Response(
        JSON.stringify({
          id: campaignId,
          tenant_id: "77777777-7777-4777-8777-777777777777",
          name: "Launch",
          subject: "Launch",
          status: "draft",
          created_at: "2026-08-09T00:00:00Z",
          updated_at: "2026-08-09T00:01:00Z",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"campaign-next-version"',
          },
        },
      );
    });
    const client = new PostwaveClient({
      apiKey: "pw_assurance",
      fetch,
      retries: 0,
    });
    const contract: FactContractV1 = {
      schema_version: 1,
      primary_intent: { kind: "invite", statement: "Invite customers" },
      audience_context: { description: "Existing Pro customers" },
      core_claim: { statement: "The webinar demonstrates automation" },
      primary_action: {
        action_id: "register",
        block_id: "cta",
        role: "register",
        label: "Reserve my seat",
        canonical_url: "https://example.test/events/launch",
      },
      required_facts: [],
      forbidden_claims: [],
      allowed_secondary_actions: ["unsubscribe"],
      language: "en-IN",
    };

    const result = await client.campaignAssurance.setFactContract(
      campaignId,
      contract,
      {
        ifMatch: '"campaign-reviewed-version"',
        idempotencyKey: "fact-contract-set",
      },
    );

    expect(request).toMatchObject({
      method: "PUT",
      url: `https://api.moosewave.com/api/v1/campaigns/${campaignId}/fact-contract`,
    });
    expect(request?.headers["If-Match"]).toBe('"campaign-reviewed-version"');
    expect(request?.headers["Idempotency-Key"]).toBe("fact-contract-set");
    expect(JSON.parse(request?.body ?? "{}")).toEqual(contract);
    expect(result.campaign.id).toBe(campaignId);
    expect(result.etag).toBe('"campaign-next-version"');
  });

  it("refuses a Fact Contract success response without the next strong ETag", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: campaignId }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new PostwaveClient({
      apiKey: "pw_assurance",
      fetch,
      retries: 0,
    });
    await expect(
      client.campaignAssurance.setFactContract(
        campaignId,
        {},
        {
          ifMatch: '"campaign-reviewed-version"',
        },
      ),
    ).rejects.toThrow(/exact strong campaign ETag/);
  });

  it("wires every mounted route with bearer auth, paging, and explicit retry keys", async () => {
    const requests: Array<{
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string | null;
    }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push({
        method: String(init.method),
        url,
        headers: init.headers as Record<string, string>,
        body: typeof init.body === "string" ? init.body : null,
      });
      const isEvents = url.endsWith("/events");
      return new Response(
        JSON.stringify({
          measurement,
          data: isEvents
            ? {
                run_id: runId,
                state: "running",
                gate_decision: "pending",
                attempt_count: 1,
                required_extractions: 2,
                terminal_extractions: 1,
                successful_extractions: 1,
                extraction_errors: 0,
                finding_count: 0,
                blocking_finding_count: 0,
                updated_at: "2026-08-09T00:00:00Z",
                event_history_available: false,
                event_history_explanation:
                  "durable event history is not available; this is a snapshot",
                source_classes: ["deterministic"],
              }
            : {},
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const client = new PostwaveClient({
      apiKey: "pw_assurance",
      fetch,
      retries: 0,
    });

    await client.campaignAssurance.createRun(
      campaignId,
      {
        profile: "full",
        content_revision_id: revisionId,
        send_plan_id: planId,
        request_id: requestId,
      },
      { idempotencyKey: "assurance-create" },
    );
    await client.campaignAssurance.getLatest(campaignId);
    await client.campaignAssurance.getRun(campaignId, runId);
    await client.campaignAssurance.getManifest(campaignId, runId);
    await client.campaignAssurance.getEvidence(campaignId, runId, {
      offset: 20,
      limit: 50,
    });
    const events = await client.campaignAssurance.getEvents(campaignId, runId);
    await client.campaignAssurance.appealFinding(
      campaignId,
      runId,
      findingId,
      {
        request_id: requestId,
        decision: "allow_send",
        reason: "Approved bounded exception",
      },
      { idempotencyKey: "assurance-appeal" },
    );
    await client.campaignAssurance.overrideFinding(
      campaignId,
      runId,
      findingId,
      {
        request_id: requestId,
        decision: "reject",
        reason: "Rejected after evidence review",
      },
      { idempotencyKey: "assurance-override" },
    );
    const untypedApplyInput = {
      request_id: requestId,
      typed_patch: { operation: "replace_subject", value: "injected" },
    };
    await client.campaignAssurance.applyFinding(
      campaignId,
      runId,
      findingId,
      untypedApplyInput,
      {
        ifMatch: '"campaign-reviewed-version"',
        idempotencyKey: "assurance-apply",
      },
    );
    await client.campaignAssurance.cancelRun(campaignId, runId, {
      idempotencyKey: "assurance-cancel",
    });

    const base = `https://api.moosewave.com/api/v1/campaigns/${campaignId}`;
    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", `${base}/assurance-runs`],
      ["GET", `${base}/assurance`],
      ["GET", `${base}/assurance-runs/${runId}`],
      ["GET", `${base}/assurance-runs/${runId}/manifest`],
      ["GET", `${base}/assurance-runs/${runId}/evidence?offset=20&limit=50`],
      ["GET", `${base}/assurance-runs/${runId}/events`],
      ["POST", `${base}/assurance-runs/${runId}/findings/${findingId}/appeals`],
      [
        "POST",
        `${base}/assurance-runs/${runId}/findings/${findingId}/overrides`,
      ],
      ["POST", `${base}/assurance-runs/${runId}/findings/${findingId}/apply`],
      ["POST", `${base}/assurance-runs/${runId}/cancel`],
    ]);
    expect(
      requests.every(
        (request) => request.headers.Authorization === "Bearer pw_assurance",
      ),
    ).toBe(true);
    expect(requests[0]?.headers["Idempotency-Key"]).toBe("assurance-create");
    expect(requests[6]?.headers["Idempotency-Key"]).toBe("assurance-appeal");
    expect(requests[7]?.headers["Idempotency-Key"]).toBe("assurance-override");
    expect(requests[8]?.headers["Idempotency-Key"]).toBe("assurance-apply");
    expect(requests[8]?.headers["If-Match"]).toBe(
      '"campaign-reviewed-version"',
    );
    expect(JSON.parse(requests[8]?.body ?? "{}")).toEqual({
      request_id: requestId,
    });
    expect(requests[9]?.headers["Idempotency-Key"]).toBe("assurance-cancel");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      profile: "full",
      content_revision_id: revisionId,
      send_plan_id: planId,
      request_id: requestId,
    });
    expect(events.data.event_history_available).toBe(false);
    expect(events.measurement.source_classes[1]?.present).toBe(false);
  });

  it("auto-mints the required key when an explicit cross-process key is omitted", async () => {
    let key: string | undefined;
    const fetch = vi.fn(async (_url: string, init: RequestInit = {}) => {
      key = (init.headers as Record<string, string>)["Idempotency-Key"];
      return new Response(JSON.stringify({ measurement, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new PostwaveClient({
      apiKey: "pw_assurance",
      fetch,
      retries: 0,
    });
    await client.campaignAssurance.cancelRun(campaignId, runId);
    expect(key).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rejects anything except one exact strong campaign ETag before transport", async () => {
    const fetch = vi.fn();
    const client = new PostwaveClient({
      apiKey: "pw_assurance",
      fetch,
      retries: 0,
    });
    for (const ifMatch of [
      "",
      "*",
      'W/"weak"',
      '"one", "two"',
      "bare",
      ' "spaced"',
      '"unsafe\nvalue"',
    ]) {
      expect(() =>
        client.campaignAssurance.applyFinding(
          campaignId,
          runId,
          findingId,
          { request_id: requestId },
          { ifMatch, idempotencyKey: "assurance-apply" },
        ),
      ).toThrow(/exact strong campaign ETag/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
