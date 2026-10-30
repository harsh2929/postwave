import { describe, expect, it } from "vitest";

import {
  parseBlocklistHits,
  parseBounceClassBreakdown,
  parseDeliverabilityHistory,
  parseDeliverabilitySummary,
  parseDnsHealthRows,
  parseWebhookErrors,
} from "../../pages/deliverability-hub-response-contract";

const summary = {
  score: 92,
  grade: "A",
  status: "healthy",
  trend: "up",
  trend_delta: 2,
  trend_reference_at: "2026-07-07T00:00:00Z",
  history: [90, 91, 92],
  breaches: [],
  auto_throttled: false,
  event_rate_scope: "campaigns",
  model_version: "campaign-cohort-v2-2026-08-02",
  sample_qualified: true,
  minimum_sample_sends: 1000,
  totals: { sends_7d: 1000, sends_30d: 4000 },
  computed_at: "2026-07-14T00:00:00Z",
};

describe("deliverability hub response contracts", () => {
  it("accepts complete hub summary and history payloads", () => {
    expect(parseDeliverabilitySummary(summary)).toEqual(summary);
    const history = {
      snapshots: [
        {
          sampled_at: "2026-07-14T00:00:00Z",
          score: 92,
          model_version: "campaign-cohort-v2-2026-08-02",
          sample_qualified: true,
          sample_size: 4000,
        },
      ],
      window_days: 30,
      count: 1,
      model_version: "campaign-cohort-v2-2026-08-02",
    };
    expect(parseDeliverabilityHistory(history)).toEqual(history);
  });

  it("rejects partial and non-finite summary/history payloads", () => {
    expect(parseDeliverabilitySummary({ items: [] })).toBeNull();
    expect(
      parseDeliverabilitySummary({ ...summary, score: Number.NaN }),
    ).toBeNull();
    expect(
      parseDeliverabilityHistory({
        snapshots: [
          {
            sampled_at: "now",
            score: Number.POSITIVE_INFINITY,
            model_version: "campaign-cohort-v2-2026-08-02",
            sample_qualified: true,
            sample_size: 4000,
          },
        ],
        window_days: 30,
        count: 1,
        model_version: "campaign-cohort-v2-2026-08-02",
      }),
    ).toBeNull();
    expect(
      parseDeliverabilitySummary({ ...summary, sample_qualified: "yes" }),
    ).toBeNull();
    expect(
      parseDeliverabilityHistory({
        snapshots: [],
        window_days: 30,
        count: 1,
        model_version: "campaign-cohort-v2-2026-08-02",
      }),
    ).toBeNull();
  });

  it("validates DNS, blocklist, and webhook envelopes", () => {
    expect(parseDnsHealthRows({ identities: [] })).toEqual([]);
    expect(
      parseDnsHealthRows({
        identities: [
          {
            id: "identity-1",
            domain: "mail.example.test",
            verify_state: "pending",
            is_stale: true,
            hours_since_last_check: -1,
          },
        ],
      }),
    ).toHaveLength(1);
    expect(parseBlocklistHits({ items: [] })).toEqual([]);
    expect(parseWebhookErrors({ items: [] })).toEqual([]);
    expect(parseDnsHealthRows({ items: [] })).toBeNull();
    expect(parseBlocklistHits({ items: [{}] })).toBeNull();
    expect(parseWebhookErrors({ items: [{}] })).toBeNull();
  });

  it("requires current, internally consistent DNS verification evidence", () => {
    const base = {
      id: "identity-1",
      domain: "mail.example.test",
      verify_state: "partial",
      spf_verified_at: "2026-07-14T00:00:00Z",
      last_attempt_at: "2026-07-14T00:05:00Z",
      is_stale: false,
      hours_since_last_check: 1,
    };
    expect(parseDnsHealthRows({ identities: [base] })).toEqual([base]);
    for (const row of [
      { ...base, verify_state: "mystery" },
      { ...base, spf_verified_at: "not-a-time" },
      { ...base, last_attempt_at: "not-a-time" },
      { ...base, id: "" },
      { ...base, domain: "mail.example.test\ncontrol" },
      { ...base, verify_state: "broken" },
      { ...base, verify_state: "verified" },
    ]) {
      expect(parseDnsHealthRows({ identities: [row] })).toBeNull();
    }
    expect(
      parseDnsHealthRows({
        identities: [
          {
            ...base,
            verify_state: "verified",
            dkim_verified_at: "2026-07-14T00:00:00Z",
            dmarc_verified_at: "2026-07-14T00:00:00Z",
          },
        ],
      }),
    ).toHaveLength(1);
  });

  it("requires bounded, safe blocklist row evidence", () => {
    const hit = {
      id: "ip|192.0.2.1|zen.example.test",
      list_name: "zen.example.test",
      identifier: "192.0.2.1",
      identifier_type: "ip",
      first_seen_at: "2026-07-14T00:00:00Z",
      confidence: 0.95,
    };
    expect(parseBlocklistHits({ items: [hit] })).toEqual([hit]);
    for (const row of [
      { ...hit, id: "" },
      { ...hit, list_name: "zen\ncontrol" },
      { ...hit, first_seen_at: "yesterday" },
      { ...hit, confidence: -0.01 },
      { ...hit, confidence: 1.01 },
    ]) {
      expect(parseBlocklistHits({ items: [row] })).toBeNull();
    }
  });

  it("contains webhook URL credentials, raw errors, and controls before state", () => {
    const pathSecret = "path-secret-canary";
    const querySecret = "query-secret-canary";
    const errorSecret = "error-secret-canary";
    const parsed = parseWebhookErrors({
      items: [
        {
          id: "delivery-1",
          event: "subscriber.created",
          url: `https://live-user:live-password@hooks.example.test/${pathSecret}?token=${querySecret}#fragment-secret`,
          error: `HTTP 502 Authorization: Bearer ${errorSecret}\r\nX-Injected: yes`,
          status_code: 502,
          attempt_count: 3,
          last_attempt_at: "2026-07-14T00:00:00Z",
          status: "failed",
        },
      ],
    });
    expect(parsed).toEqual([
      {
        id: "delivery-1",
        event: "subscriber.created",
        url: "https://hooks.example.test",
        error: "Receiver returned HTTP 502",
        status_code: 502,
        attempt_count: 3,
        last_attempt_at: "2026-07-14T00:00:00Z",
        status: "failed",
      },
    ]);
    const state = JSON.stringify(parsed);
    for (const forbidden of [
      "live-user",
      "live-password",
      pathSecret,
      querySecret,
      errorSecret,
      "fragment-secret",
      "X-Injected",
      "\\r",
      "\\n",
    ]) {
      expect(state).not.toContain(forbidden);
    }
  });

  it("rejects a malformed bounce response before chart rendering", () => {
    const payload = {
      window_days: 30,
      total_bounces: 2,
      classes: [{ class_code: "soft", label: "Soft", count: 2, share: 1 }],
    };
    expect(parseBounceClassBreakdown(payload)).toEqual(payload);
    expect(parseBounceClassBreakdown({ items: [] })).toBeNull();
    expect(
      parseBounceClassBreakdown({
        ...payload,
        classes: [{ ...payload.classes[0], share: Number.NaN }],
      }),
    ).toBeNull();
  });
});
