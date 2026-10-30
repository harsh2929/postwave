// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});

import { ApiError } from "@/lib/api";
import {
  getPiiScanConfig,
  listPiiFindings,
  listSubscriberPiiFindings,
  reviewPiiFinding,
  setPiiScanEnabled,
  validatePiiReviewInput,
  type PiiFinding,
  type PiiReviewInput,
  type PiiScanConfig,
} from "@/lib/pii-findings-api";

const FINDING_ID = "00000000-0000-4000-8000-000000000101";
const SUBSCRIBER_ID = "00000000-0000-4000-8000-000000000201";
const ACTOR_ID = "00000000-0000-4000-8000-000000000301";
const RECEIPT_ID = "00000000-0000-4000-8000-000000000401";
const FINGERPRINT = "a".repeat(64);

const metadata = {
  scanner_name: "postwave-shadow-pii",
  scanner_version: "2.0.0",
  detector_name: "regex-heuristic",
  detector_version: "2.0.0",
  policy_name: "undeclared-pii-review",
  policy_version: "sub-071-v2",
} as const;

function pendingFinding(): PiiFinding {
  return {
    id: FINDING_ID,
    subscriber_id: SUBSCRIBER_ID,
    field_name: "crm_notes",
    detected_type: "ssn",
    confidence: 0.98,
    fingerprint: FINGERPRINT,
    fingerprint_scheme: "hmac-sha256-v1",
    fingerprint_key_version: "active-v1",
    status: "pending",
    ...metadata,
    created_at: "2026-08-29T10:00:00Z",
    updated_at: "2026-08-29T10:01:00Z",
  };
}

const reviewInput: PiiReviewInput = {
  status: "reviewed",
  reason: "confirmed_pii",
  comment: "Verified in the privacy case and assigned remediation ownership.",
  evidence_reference: "ticket:DPO-123",
  expected_updated_at: "2026-08-29T10:01:00Z",
};

function reviewedFinding(): PiiFinding {
  return {
    ...pendingFinding(),
    status: "reviewed",
    reviewed_at: "2026-08-29T10:02:00Z",
    reviewed_by: `user:${ACTOR_ID}`,
    updated_at: "2026-08-29T10:02:00Z",
    review_receipt: {
      receipt_id: RECEIPT_ID,
      status: "reviewed",
      reason: "confirmed_pii",
      comment: reviewInput.comment,
      evidence_reference: reviewInput.evidence_reference,
      reviewed_at: "2026-08-29T10:02:00Z",
      actor_type: "user",
      actor_id: ACTOR_ID,
      ...metadata,
      fingerprint: FINGERPRINT,
      fingerprint_scheme: "hmac-sha256-v1",
      fingerprint_key_version: "active-v1",
      finding_updated_at: reviewInput.expected_updated_at,
    },
  };
}

function scanConfig(enabled = true): PiiScanConfig {
  return {
    available: true,
    scan_enabled: enabled,
    status: enabled ? "enabled_caught_up" : "disabled",
    execution_mode: "transactional_revision_outbox",
    scheduled_scans_available: false,
    ...metadata,
    fingerprint_scheme: "hmac-sha256-v1",
    fingerprint_key_version: "active-v1",
    reliability: "at_least_once_with_dlq",
    coverage: enabled ? "current_snapshot_covered" : "disabled",
    coverage_limitations: enabled
      ? [
          "current_profile_snapshot_only_intermediate_revisions_may_be_coalesced",
          "retained_attribute_history_notes_and_event_content_not_scanned",
          "bounded_detector_truncation_requires_operator_repair",
        ]
      : ["scanning_disabled"],
    max_scan_fields: 500,
    max_scan_field_bytes: 65_536,
    max_scan_subscriber_bytes: 4_194_304,
    max_detections_per_field: 50,
    max_detections_per_subscriber: 200,
    coverage_evidence: {
      generation: 7,
      status: enabled ? "caught_up" : "disabled",
      snapshot_exact: enabled,
      total_subscribers: 1,
      covered_subscribers: enabled ? 1 : 0,
      pending_subscribers: 0,
      retrying_subscribers: 0,
      dead_letter_subscribers: 0,
      truncated_subscribers: 0,
      missing_state_subscribers: 0,
      coalesced_revisions: 2,
    },
    updated_at: "2026-08-29T10:03:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Shadow-PII web client", () => {
  it("sends bounded privacy-safe queue filters and verifies pagination", async () => {
    mocks.get.mockResolvedValue({
      items: [pendingFinding()],
      total: 1,
      page: 1,
      per_page: 25,
    });
    const signal = new AbortController().signal;

    const page = await listPiiFindings({
      status: "pending",
      detectedType: "ssn",
      query: " crm_notes ",
      page: 1,
      perPage: 25,
      signal,
    });

    expect(page.items[0]?.id).toBe(FINDING_ID);
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/pii-findings", {
      query: {
        status: "pending",
        detected_type: "ssn",
        q: "crm_notes",
        page: 1,
        per_page: 25,
      },
      signal,
    });
  });

  it("rejects forbidden matched-value fields before they can enter query cache", async () => {
    mocks.get.mockResolvedValue({
      items: [{ ...pendingFinding(), matched_value: "never-cache-this" }],
      total: 1,
      page: 1,
      per_page: 25,
    });

    const rejection = await listPiiFindings({ page: 1, perPage: 25 }).catch(
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(ApiError);
    expect((rejection as ApiError).code).toBe("invalid_pii_contract");
    expect((rejection as ApiError).body).toBeUndefined();
  });

  it("does not put personal-data-shaped search text into a request URL", async () => {
    await expect(
      listPiiFindings({ query: "jane@example.test", page: 1, perPage: 25 }),
    ).rejects.toMatchObject({ code: "invalid_filter" });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("rejects personal data in receipt comments and partial terminal stamps", async () => {
    const unsafeReceipt = reviewedFinding();
    unsafeReceipt.review_receipt!.comment = "Confirmed jane@example.test.";
    mocks.get.mockResolvedValueOnce({
      items: [unsafeReceipt],
      total: 1,
      page: 1,
      per_page: 25,
    });
    await expect(
      listPiiFindings({ page: 1, perPage: 25 }),
    ).rejects.toMatchObject({ code: "invalid_pii_contract" });

    mocks.get.mockResolvedValueOnce({
      items: [
        {
          ...pendingFinding(),
          reviewed_at: "2026-08-29T10:02:00Z",
        },
      ],
      total: 1,
      page: 1,
      per_page: 25,
    });
    await expect(
      listPiiFindings({ page: 1, perPage: 25 }),
    ).rejects.toMatchObject({ code: "invalid_pii_contract" });
  });

  it("rejects subscriber identity drift from the tenant-bound detail endpoint", async () => {
    mocks.get.mockResolvedValue({
      items: [
        {
          ...pendingFinding(),
          subscriber_id: "00000000-0000-4000-8000-000000000999",
        },
      ],
      total: 1,
      page: 1,
      per_page: 50,
    });

    await expect(
      listSubscriberPiiFindings(SUBSCRIBER_ID, { page: 1, perPage: 50 }),
    ).rejects.toMatchObject({ code: "invalid_pii_contract" });
  });

  it("blocks personal-data-shaped comments locally without issuing PATCH", async () => {
    const unsafe: PiiReviewInput = {
      ...reviewInput,
      comment: "Confirmed jane@example.test in the record.",
    };
    expect(validatePiiReviewInput(unsafe)).toContain(
      "Remove personal-data-shaped values",
    );

    await expect(reviewPiiFinding(FINDING_ID, unsafe)).rejects.toMatchObject({
      code: "invalid_pii_review_input",
    });
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("records a compare-and-set decision online and verifies its immutable receipt", async () => {
    mocks.patch.mockResolvedValue(reviewedFinding());

    const result = await reviewPiiFinding(FINDING_ID, reviewInput);

    expect(result.review_receipt?.receipt_id).toBe(RECEIPT_ID);
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/pii-findings/${FINDING_ID}`,
      reviewInput,
      { requireOnline: true, maxAttempts: 1 },
    );
  });

  it("validates current transactional coverage and keeps config writes online", async () => {
    mocks.get.mockResolvedValueOnce(scanConfig(true));
    expect((await getPiiScanConfig()).status).toBe("enabled_caught_up");

    mocks.post.mockResolvedValueOnce(scanConfig(false));
    const result = await setPiiScanEnabled(false);
    expect(result.scan_enabled).toBe(false);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/pii-scan-config",
      { scan_enabled: false },
      { requireOnline: true, maxAttempts: 1 },
    );
  });

  it("rejects contradictory scanner capability evidence", async () => {
    mocks.get.mockResolvedValue({
      ...scanConfig(true),
      coverage: "known_gaps",
    });
    await expect(getPiiScanConfig()).rejects.toMatchObject({
      code: "invalid_pii_contract",
    });
  });

  it("rejects impossible page geometry instead of treating it as an empty page", async () => {
    mocks.get.mockResolvedValue({
      items: [],
      total: 1,
      page: 1,
      per_page: 25,
    });
    await expect(
      listPiiFindings({ page: 1, perPage: 25 }),
    ).rejects.toMatchObject({ code: "invalid_pii_contract" });
  });
});
