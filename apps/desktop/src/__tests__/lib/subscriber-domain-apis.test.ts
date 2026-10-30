import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubLocalStorage: Storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

beforeEach(() => {
  // @ts-expect-error - minimal browser shell for api-client helpers.
  globalThis.window = {
    localStorage: stubLocalStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
});

afterEach(() => {
  // @ts-expect-error - clean up test browser shell.
  delete globalThis.window;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import { decisionExplanationsApi } from "../../lib/api/decision-explanations";
import { piiFindingsApi } from "../../lib/api/pii-findings";
import { lookalikeApi } from "../../lib/api/subscriber-lookalike";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  init: RequestInit;
} {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return { url: String(call[0]), init: call[1] as RequestInit };
}

describe("subscriber lookalike API", () => {
  it("creates lookalikes through the extracted module with the long-running POST shape", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          id: "look_1",
          name: "VIP lookalike",
          seed_segment_id: "seg_1",
          size_requested: 1000,
          member_count: 321,
          seed_count: 42,
          model_version: "v1",
          status: "ready",
          payload: { bands: { high: 100, medium: 200, low: 21 } },
          created_at: "2026-06-01T00:00:00Z",
          updated_at: "2026-06-01T00:00:00Z",
        },
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookalikeApi.create({
      name: "VIP lookalike",
      seed_segment_id: "seg_1",
      size: 1000,
      confidence_threshold: 0.8,
      data_use_acknowledged: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.data?.member_count).toBe(321);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = lastRequest(fetchMock);
    expect(url).toContain("/api/v1/subscribers/lookalike");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "VIP lookalike",
      seed_segment_id: "seg_1",
      size: 1000,
      confidence_threshold: 0.8,
      data_use_acknowledged: true,
    });
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("X-Postwave-Client")).toBe("desktop");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("encodes lookalike detail pagination and export destinations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          audience: {
            id: "look/1",
            name: "VIP",
            seed_segment_id: "seg_1",
            size_requested: 100,
            member_count: 1,
            seed_count: 1,
            model_version: "v1",
            status: "ready",
            payload: {},
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
          members: [],
          page: 2,
          per_page: 50,
          pii_included: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "look/1",
          name: "VIP",
          seed_segment_id: "seg_1",
          size_requested: 100,
          member_count: 1,
          seed_count: 1,
          model_version: "v1",
          status: "ready",
          exported_destination_id: "dest_1",
          payload: {},
          created_at: "2026-06-01T00:00:00Z",
          updated_at: "2026-06-01T00:00:00Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await lookalikeApi.get("look/1", { page: 2, perPage: 50 });
    let request = lastRequest(fetchMock);
    expect(request.url).toContain(
      "/api/v1/subscribers/lookalike/look%2F1?page=2&per_page=50",
    );

    await lookalikeApi.export("look/1", "dest_1");
    request = lastRequest(fetchMock);
    expect(request.url).toContain(
      "/api/v1/subscribers/lookalike/look%2F1/export",
    );
    expect(request.init.method).toBe("POST");
    expect(JSON.parse(request.init.body as string)).toEqual({
      destination_id: "dest_1",
    });
  });

  it("rejects cross-audience identities and does not expose default member PII", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          audience: {
            id: "different",
            name: "Wrong audience",
            seed_segment_id: "seg_1",
            size_requested: 100,
            member_count: 1,
            seed_count: 50,
            model_version: "first-party-v1",
            status: "ready",
            payload: {},
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
          members: [],
          page: 1,
          per_page: 1,
          pii_included: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          audience: {
            id: "look_1",
            name: "Leaky audience",
            seed_segment_id: "seg_1",
            size_requested: 100,
            member_count: 1,
            seed_count: 50,
            model_version: "first-party-v1",
            status: "ready",
            payload: {},
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
          members: [{ subscriber_id: "sub_1", email: "private@example.com" }],
          page: 1,
          per_page: 1,
          pii_included: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const mismatch = await lookalikeApi.get("look_1");
    const leak = await lookalikeApi.get("look_1");

    expect(mismatch.error?.code).toBe("subscriber_response_identity_mismatch");
    expect(leak.error?.code).toBe("invalid_subscriber_response_contract");
    expect(lastRequest(fetchMock).url).not.toContain("include_pii=true");
  });

  it("polls pending jobs to a terminal state and supports an abortable wait", async () => {
    const audience = (status: "running" | "ready") => ({
      audience: {
        id: "look_1",
        name: "VIP",
        seed_segment_id: "seg_1",
        size_requested: 100,
        member_count: status === "ready" ? 12 : 0,
        seed_count: 50,
        model_version: "first-party-v1",
        status,
        payload: {},
        created_at: "2026-06-01T00:00:00Z",
        updated_at: "2026-06-01T00:00:00Z",
      },
      members: [],
      page: 1,
      per_page: 1,
      pii_included: false,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(audience("running")))
      .mockResolvedValueOnce(jsonResponse(audience("ready")));
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookalikeApi.waitForTerminal("look_1", {
      intervalMs: 100,
      wait: async () => true,
    });
    const stopped = await lookalikeApi.waitForTerminal("look_1", {
      wait: async () => false,
    });

    expect(result.data?.status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stopped.error?.code).toBe("aborted");
  });
});

describe("decision explanations API", () => {
  it("reads live segment membership and stored explanations with encoded subscriber ids", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          subscriber_id: "sub/1",
          segments: [
            {
              segment_id: "seg_1",
              segment_name: "VIP",
              is_member: true,
              matched_count: 1,
              total_conditions: 1,
              summary: "matched",
              conditions: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          subscriber_id: "sub/1",
          items: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await decisionExplanationsApi.getSegmentMembership("sub/1");
    expect(lastRequest(fetchMock).url).toContain(
      "/api/v1/subscribers/sub%2F1/segment-membership",
    );

    await decisionExplanationsApi.getSubscriberDecisionExplanations("sub/1");
    expect(lastRequest(fetchMock).url).toContain(
      "/api/v1/subscribers/sub%2F1/decision-explanations",
    );
  });

  it("records decision explanation snapshots as explicit online writes", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          subscriber_id: "sub_1",
          items: [
            {
              id: "dec_1",
              subscriber_id: "sub_1",
              decision_type: "segment",
              target_id: "seg_1",
              reasoning_snapshot: { score: 0.9 },
              created_at: "2026-06-01T00:00:00Z",
              updated_at: "2026-06-01T00:00:00Z",
            },
          ],
        },
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result =
      await decisionExplanationsApi.recordSubscriberDecisionExplanation(
        "sub_1",
        {
          decision_type: "segment",
          target_id: "seg_1",
          reasoning_snapshot: { score: 0.9 },
        },
      );

    expect(result.error).toBeUndefined();
    expect(result.data?.items[0].id).toBe("dec_1");
    const { url, init } = lastRequest(fetchMock);
    expect(url).toContain("/api/v1/subscribers/sub_1/decision-explanations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      decision_type: "segment",
      target_id: "seg_1",
      reasoning_snapshot: { score: 0.9 },
    });
  });

  it("rejects subscriber identity mismatches before returning decisions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ subscriber_id: "other", segments: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          subscriber_id: "sub_1",
          items: [
            {
              id: "decision-1",
              subscriber_id: "other",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const membership =
      await decisionExplanationsApi.getSegmentMembership("sub_1");
    const explanations =
      await decisionExplanationsApi.getSubscriberDecisionExplanations("sub_1");
    expect(membership.error?.code).toBe(
      "subscriber_response_identity_mismatch",
    );
    expect(explanations.error?.code).toBe(
      "subscriber_response_identity_mismatch",
    );
  });
});

describe("subscriber PII findings API", () => {
  it("rejects mismatched subscriber and finding identities", async () => {
    const subscriberId = "11111111-1111-4111-8111-111111111111";
    const otherSubscriberId = "22222222-2222-4222-8222-222222222222";
    const findingId = "33333333-3333-4333-8333-333333333333";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: findingId,
              subscriber_id: otherSubscriberId,
              field_name: "profile.note",
              detected_type: "other",
              confidence: 0.8,
              fingerprint: "a".repeat(64),
              fingerprint_scheme: "hmac-sha256-v1",
              fingerprint_key_version: "key-2026-07",
              status: "pending",
              scanner_name: "postwave-shadow-pii",
              scanner_version: "2.0.0",
              detector_name: "regex-heuristic",
              detector_version: "2.0.0",
              policy_name: "undeclared-pii-review",
              policy_version: "sub-071-v2",
              created_at: "2026-07-18T08:00:00Z",
              updated_at: "2026-07-18T08:00:00Z",
            },
          ],
          total: 1,
          page: 1,
          per_page: 50,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "44444444-4444-4444-8444-444444444444",
          subscriber_id: subscriberId,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const list = await piiFindingsApi.listForSubscriber(subscriberId);
    const patch = await piiFindingsApi.review(findingId, {
      status: "reviewed",
      reason: "confirmed_pii",
      comment: "Verified by the privacy owner.",
      evidence_reference: "ticket:DPO-123",
      expected_updated_at: "2026-07-18T08:00:00Z",
    });
    expect(list.error?.code).toBe("subscriber_response_identity_mismatch");
    expect(patch.error?.code).toBe("subscriber_response_identity_mismatch");
  });
});
