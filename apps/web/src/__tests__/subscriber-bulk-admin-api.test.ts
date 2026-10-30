// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SubscriberBulkAdminContractError,
  changeSelectedSubscriberConsent,
  normalizeBulkConsentEvidence,
  parseSelectedBulkOperationResult,
  removeTagFromSelectedSubscribers,
  selectedSubscriberTargets,
  validateSelectedSubscriberEmails,
  type BulkConsentEvidenceInput,
} from "@/lib/subscriber-bulk-admin-api";

const first = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "First@Example.com",
};
const second = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "second@example.com",
};

const evidence: BulkConsentEvidenceInput = {
  category: "email_marketing",
  source: "signed_form",
  channel: "web",
  legal_basis: "consent",
  occurred_at: "2026-08-29T09:00:00.000Z",
  jurisdiction: "us-ca",
  evidence: " receipt:CONSENT-123 ",
  reason: " Reviewed the signed first-party record. ",
  policy_version: " privacy-2026-08 ",
};

function verdict(email: string, valid = true) {
  return {
    email,
    valid,
    verdict: valid ? "ok" : "no_mx",
    domain: "example.com",
    has_mx: valid,
    disposable: false,
    role_account: false,
    reasons: valid ? [] : ["domain has no MX records"],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("selected subscriber bulk admin API", () => {
  it("binds every validation verdict back to the exact selected id and sends no mutation identity", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: [verdict("first@example.com"), verdict(second.email, false)],
        summary: { total: 2, valid: 1, invalid: 1 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateSelectedSubscriberEmails([first, second]);

    expect(result.results.map((item) => item.subscriber_id)).toEqual([
      first.id,
      second.id,
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://localhost:8080/api/v1/email-validation/check-batch",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      emails: ["first@example.com", "second@example.com"],
    });
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeNull();
  });

  it("fails closed when validation omits, duplicates, or substitutes a selected address", async () => {
    for (const results of [
      [verdict("first@example.com")],
      [verdict("first@example.com"), verdict("first@example.com")],
      [verdict("first@example.com"), verdict("other@example.com")],
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            results,
            summary: { total: 2, valid: 2, invalid: 0 },
          }),
        ),
      );
      await expect(
        validateSelectedSubscriberEmails([first, second]),
      ).rejects.toBeInstanceOf(SubscriberBulkAdminContractError);
    }
  });

  it("rejects ambiguous or invalid selected identities before transport", () => {
    expect(() =>
      selectedSubscriberTargets([
        first,
        { ...second, email: " FIRST@example.com " },
      ]),
    ).toThrow("missing, duplicate, or invalid");
    expect(() =>
      selectedSubscriberTargets([{ id: "not-a-uuid", email: "a@b.test" }]),
    ).toThrow("missing, duplicate, or invalid");
  });

  it("normalizes the complete evidence envelope without inventing evidence", () => {
    expect(normalizeBulkConsentEvidence(evidence)).toEqual({
      ...evidence,
      jurisdiction: "US-CA",
      evidence: "receipt:CONSENT-123",
      reason: "Reviewed the signed first-party record.",
      policy_version: "privacy-2026-08",
    });
    expect(() =>
      normalizeBulkConsentEvidence({ ...evidence, evidence: " " }),
    ).toThrow("Evidence must be present");
  });

  it("posts an admin consent decision with a stable mutation identity and reconciles partial success", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        affected: 1,
        skipped: 1,
        source: "explicit_ids",
        exclusions: { suppression_evidence_conflict: 1 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await changeSelectedSubscriberConsent(
      [first, second],
      "grant",
      evidence,
      { idempotencyKey: "subscriber-consent-grant:test-1" },
    );

    expect(result).toMatchObject({ requested: 2, affected: 1, skipped: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://localhost:8080/api/v1/subscribers/bulk/grant-consent",
    );
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
      "subscriber-consent-grant:test-1",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      subscriber_ids: [first.id, second.id],
      category: "email_marketing",
      jurisdiction: "US-CA",
      evidence: "receipt:CONSENT-123",
    });
  });

  it("rejects a bulk result that cannot account for the frozen scope", () => {
    expect(() =>
      parseSelectedBulkOperationResult(
        { affected: 1, skipped: 0, source: "explicit_ids" },
        2,
      ),
    ).toThrow("invalid response");
  });

  it("wires the existing untag endpoint with bounded tag and recovery evidence", async () => {
    const token = "a".repeat(64);
    const fetchMock = vi.fn(async () =>
      Response.json({
        affected: 1,
        source: "explicit_ids",
        recovery_token: token,
        recovery_until: "2026-08-30T12:00:00Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await removeTagFromSelectedSubscribers(
      [first, second],
      " vip ",
      { idempotencyKey: "subscriber-untag:test-1" },
    );

    expect(result).toMatchObject({
      requested: 2,
      affected: 1,
      skipped: 1,
      recovery_token: token,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://localhost:8080/api/v1/subscribers/bulk/untag",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      subscriber_ids: [first.id, second.id],
      tag: "vip",
    });
  });
});
