import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type PIIFinding,
  type PIIReviewInput,
  piiReviewCommentContainsStrongPII,
  piiFindingsApi,
} from "../../lib/api/pii-findings";

const stubLocalStorage: Storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

const META = {
  scanner_name: "postwave-shadow-pii",
  scanner_version: "2.0.0",
  detector_name: "regex-heuristic",
  detector_version: "2.0.0",
  policy_name: "undeclared-pii-review",
  policy_version: "sub-071-v2",
} as const;
const LEGACY_META = {
  scanner_name: "legacy-unversioned",
  scanner_version: "unknown-pre-1760",
  detector_name: "legacy-unversioned",
  detector_version: "unknown-pre-1760",
  policy_name: "legacy-unversioned",
  policy_version: "unknown-pre-1760",
} as const;
const FINDING_ID = "11111111-1111-4111-8111-111111111111";
const SUBSCRIBER_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  // @ts-expect-error minimal browser shell for the API transport.
  globalThis.window = {
    localStorage: stubLocalStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
});

afterEach(() => {
  // @ts-expect-error test cleanup.
  delete globalThis.window;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pending(overrides: Partial<PIIFinding> = {}): PIIFinding {
  return {
    ...META,
    id: FINDING_ID,
    subscriber_id: SUBSCRIBER_ID,
    field_name: "profile.phone_note",
    detected_type: "phone",
    confidence: 0.81,
    fingerprint: "a".repeat(64),
    fingerprint_scheme: "hmac-sha256-v1",
    fingerprint_key_version: "key-2026-07",
    status: "pending",
    created_at: "2026-07-18T07:00:00Z",
    updated_at: "2026-07-18T08:00:00Z",
    ...overrides,
  };
}

function terminal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const reviewedAt = "2026-07-18T09:00:00Z";
  return {
    ...pending(),
    status: "reviewed",
    reviewed_at: reviewedAt,
    reviewed_by: `user:${ACTOR_ID}`,
    updated_at: reviewedAt,
    review_receipt: {
      ...META,
      receipt_id: RECEIPT_ID,
      status: "reviewed",
      reason: "confirmed_pii",
      comment: "Verified without retaining the detected value.",
      evidence_reference: "ticket:DPO-123",
      reviewed_at: reviewedAt,
      actor_type: "user",
      actor_id: ACTOR_ID,
      fingerprint: "a".repeat(64),
      fingerprint_scheme: "hmac-sha256-v1",
      fingerprint_key_version: "key-2026-07",
      finding_updated_at: "2026-07-18T08:00:00Z",
      ...overrides,
    },
  };
}

function withPrototypeKey(): Record<string, unknown> {
  const finding = pending() as unknown as Record<string, unknown>;
  Object.defineProperty(finding, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { polluted: true },
  });
  return finding;
}

function withOverDeepForbiddenKey(): Record<string, unknown> {
  let nested: unknown = { raw_value: "111-22-3333" };
  for (let depth = 0; depth < 14; depth += 1) {
    nested = depth % 2 === 0 ? { child: nested } : [nested];
  }
  return { ...terminal(), review_receipt: nested };
}

describe("PII findings API integrity", () => {
  it.each([
    ["SSN", "Copied 111-22-3333"],
    ["email", "Contact ada@example.test"],
    ["IBAN", "Copied GB82WEST12345698765432"],
    ["IPv4", "Observed 192.168.10.25"],
    ["IPv6", "Observed 2001:db8:85a3::8a2e:370:7334"],
    ["long numeric identifier", "Copied 1234 5678 9012 3456"],
  ])("mirrors the server's strong-PII guard for %s", (_label, comment) => {
    expect(piiReviewCommentContainsStrongPII(comment)).toBe(true);
  });

  it.each([
    ["date", "Verified on 2026-07-18"],
    ["phone-like ticket", "Escalated via 555-123-4567"],
  ])("does not overblock the server's intentional %s exception", (_label, comment) => {
    expect(piiReviewCommentContainsStrongPII(comment)).toBe(false);
  });

  it("serializes privacy-safe server filters and binds the verified response page", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        items: [pending()],
        total: 11,
        page: 2,
        per_page: 10,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await piiFindingsApi.list({
      status: "pending",
      detectedType: "phone",
      query: "  profile.phone  ",
      page: 2,
      perPage: 10,
    });

    expect(response.error).toBeUndefined();
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: "pending",
      detected_type: "phone",
      q: "profile.phone",
      page: "2",
      per_page: "10",
    });
  });

  it.each([
    [
      "page",
      { items: [pending()], total: 1, page: 1, per_page: 10 },
      { status: "pending" as const, detectedType: "phone" as const, page: 2, perPage: 10 },
    ],
    [
      "status filter",
      { items: [terminal()], total: 1, page: 1, per_page: 10 },
      { status: "pending" as const, page: 1, perPage: 10 },
    ],
    [
      "detected-type filter",
      { items: [pending({ detected_type: "email" })], total: 1, page: 1, per_page: 10 },
      { detectedType: "phone" as const, page: 1, perPage: 10 },
    ],
  ])("rejects a response outside the requested %s", async (_label, body, options) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));
    const response = await piiFindingsApi.list(options);
    expect(response.error?.code).toBe("invalid_subscriber_response_contract");
  });

  it.each([
    ["provenance", terminal({ detector_version: "wrong" })],
    [
      "fingerprint scheme",
      terminal({
        fingerprint_scheme: "legacy-redacted-v1",
        fingerprint_key_version: "legacy",
      }),
    ],
    [
      "fingerprint key version",
      terminal({ fingerprint_key_version: "key-2026-08" }),
    ],
    ["actor stamp", { ...terminal(), reviewed_by: "user:someone-else@example.test" }],
    [
      "legacy actor pairing",
      terminal({ actor_type: "legacy", actor_id: "b".repeat(64), reason: "confirmed_pii" }),
    ],
    ["unsafe evidence", terminal({ evidence_reference: "https://example.test/?secret=x" })],
    ["strong PII comment", terminal({ comment: "Contact ada@example.test" })],
    ["nested cleartext", { ...terminal(), debug: { raw_value: "forbidden" } }],
    ["unknown finding key", { ...pending(), unexpected: true }],
    ["unknown receipt key", terminal({ unexpected: true })],
    ["prototype-like key", withPrototypeKey()],
    ["over-deep nested array/object key", withOverDeepForbiddenKey()],
    ["noncanonical fingerprint", pending({ fingerprint: "A".repeat(64) })],
    ["unknown fingerprint scheme", pending({ fingerprint_scheme: "sha256" as never })],
    ["unsafe fingerprint key version", pending({ fingerprint_key_version: "legacy" })],
    ["retired bare hash field", { ...pending(), raw_value_hash: "a".repeat(64) }],
    ["non-RFC3339 timestamp", pending({ created_at: "1" })],
    [
      "space-separated timestamp",
      pending({ updated_at: "2026-07-18 08:00:00Z" }),
    ],
    [
      "reversed finding timeline",
      pending({
        created_at: "2026-07-19T08:00:00Z",
        updated_at: "2026-07-18T08:00:00Z",
      }),
    ],
    [
      "reversed receipt timeline",
      terminal({ finding_updated_at: "2026-07-18T10:00:00Z" }),
    ],
  ])("rejects unsafe finding or receipt %s mismatch", async (_label, item) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ items: [item], total: 1, page: 1, per_page: 10 }),
      ),
    );
    const response = await piiFindingsApi.list({ page: 1, perPage: 10 });
    expect(response.error?.code).toBe("invalid_subscriber_response_contract");
  });

  it("rejects impossible sparse or out-of-range pagination", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ items: [], total: 21, page: 2, per_page: 20 }),
      ),
    );
    const response = await piiFindingsApi.list({ page: 2, perPage: 20 });
    expect(response.error?.code).toBe("invalid_subscriber_response_contract");
  });

  it("accepts RFC3339Nano timestamps with an explicit offset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          items: [
            pending({
              created_at: "2026-07-18T12:30:00.123456789+05:30",
              updated_at: "2026-07-18T13:30:00.987654321+05:30",
            }),
          ],
          total: 1,
          page: 1,
          per_page: 10,
        }),
      ),
    );
    const response = await piiFindingsApi.list({ page: 1, perPage: 10 });
    expect(response.error).toBeUndefined();
  });

  it("rejects unknown page-envelope keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          items: [pending()],
          total: 1,
          page: 1,
          per_page: 10,
          next_cursor: "must-not-be-trusted",
        }),
      ),
    );
    const response = await piiFindingsApi.list({ page: 1, perPage: 10 });
    expect(response.error?.code).toBe("invalid_subscriber_response_contract");
  });

  it("accepts honest legacy receipts read-side but rejects legacy as a submitted reason", async () => {
    const legacyFingerprint = "d".repeat(64);
    const legacy = terminal({
      ...LEGACY_META,
      actor_type: "legacy",
      actor_id: "b".repeat(64),
      reason: "legacy_migrated",
      fingerprint: legacyFingerprint,
      fingerprint_scheme: "legacy-redacted-v1",
      fingerprint_key_version: "legacy",
    });
    Object.assign(legacy, {
      ...LEGACY_META,
      fingerprint: legacyFingerprint,
      fingerprint_scheme: "legacy-redacted-v1",
      fingerprint_key_version: "legacy",
    });
    (legacy as { reviewed_by: string }).reviewed_by = `legacy:${"b".repeat(64)}`;
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [legacy], total: 1, page: 1, per_page: 10 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const list = await piiFindingsApi.list({ page: 1, perPage: 10 });
    expect(list.error).toBeUndefined();

    const invalid = {
      status: "reviewed",
      reason: "legacy_migrated",
      comment: "Invalid client attempt.",
      evidence_reference: "ticket:DPO-123",
      expected_updated_at: "2026-07-18T08:00:00Z",
    } as unknown as PIIReviewInput;
    const review = await piiFindingsApi.review(FINDING_ID, invalid);
    expect(review.error?.code).toBe("invalid_pii_review_input");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an unreviewed legacy-redacted finding with explicit legacy provenance", async () => {
    const item = pending({
      ...LEGACY_META,
      fingerprint: "e".repeat(64),
      fingerprint_scheme: "legacy-redacted-v1",
      fingerprint_key_version: "legacy",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ items: [item], total: 1, page: 1, per_page: 10 }),
      ),
    );
    const response = await piiFindingsApi.list({ page: 1, perPage: 10 });
    expect(response.error).toBeUndefined();
  });

  it("validates scanner config mutations instead of trusting rolling-deploy shapes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ...META,
          available: true,
          scan_enabled: true,
          status: "disabled",
          execution_mode: "partial_write_path_hooks",
          scheduled_scans_available: false,
          fingerprint_scheme: "hmac-sha256-v1",
          fingerprint_key_version: "key-2026-07",
          reliability: "best_effort",
          coverage: "unverified",
          coverage_limitations: [
            "no_durable_scan_intent",
            "no_retry_or_dead_letter_queue",
            "no_coverage_watermark_or_gap_ledger",
            "direct_subscriber_writers_may_bypass_hooks",
          ],
          max_scan_fields: 500,
          max_scan_field_bytes: 65_536,
          max_detections_per_field: 50,
          max_detections_per_subscriber: 200,
        }),
      ),
    );
    const response = await piiFindingsApi.setScanConfig({ scan_enabled: true });
    expect(response.error?.code).toBe("invalid_subscriber_response_contract");
  });

  it("rejects strong PII comments locally without making a review request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await piiFindingsApi.review(FINDING_ID, {
      status: "reviewed",
      reason: "confirmed_pii",
      comment: "The copied value is 111-22-3333.",
      evidence_reference: "ticket:DPO-123",
      expected_updated_at: "2026-07-18T08:00:00Z",
    });
    expect(response.error?.code).toBe("invalid_pii_review_input");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires best-effort, unverified capability metadata and a protected key only when available", async () => {
    const available = {
      ...META,
      available: true,
      scan_enabled: true,
      status: "enabled_unverified",
      execution_mode: "partial_write_path_hooks",
      scheduled_scans_available: false,
      fingerprint_scheme: "hmac-sha256-v1",
      fingerprint_key_version: "key-2026-07",
      reliability: "best_effort",
      coverage: "unverified",
      coverage_limitations: [
        "no_durable_scan_intent",
        "no_retry_or_dead_letter_queue",
        "no_coverage_watermark_or_gap_ledger",
        "direct_subscriber_writers_may_bypass_hooks",
      ],
      max_scan_fields: 500,
      max_scan_field_bytes: 65_536,
      max_detections_per_field: 50,
      max_detections_per_subscriber: 200,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(available))
      .mockResolvedValueOnce(
        jsonResponse({
          ...available,
          available: false,
          scan_enabled: false,
          status: "unavailable",
          fingerprint_scheme: undefined,
          fingerprint_key_version: undefined,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...available, coverage: "complete" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...available,
          coverage_limitations: [...available.coverage_limitations].reverse(),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...available, max_scan_fields: 501 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...available, unexpected_debug: true }),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect((await piiFindingsApi.getScanConfig()).error).toBeUndefined();
    expect((await piiFindingsApi.getScanConfig()).error).toBeUndefined();
    expect((await piiFindingsApi.getScanConfig()).error?.code).toBe(
      "invalid_subscriber_response_contract",
    );
    expect((await piiFindingsApi.getScanConfig()).error?.code).toBe(
      "invalid_subscriber_response_contract",
    );
    expect((await piiFindingsApi.getScanConfig()).error?.code).toBe(
      "invalid_subscriber_response_contract",
    );
    expect((await piiFindingsApi.getScanConfig()).error?.code).toBe(
      "invalid_subscriber_response_contract",
    );
  });
});
