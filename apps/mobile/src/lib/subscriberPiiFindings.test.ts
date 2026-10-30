/**
 * lib/subscriberPiiFindings — the review-receipt rules, tested against the
 * server contract they mirror (pii_scanner/types.go NormalizeAndValidate).
 *
 * Load-bearing claims:
 *  - the reason taxonomies are OUTCOME-SPECIFIC and do not overlap — a
 *    "dismissed + confirmed_pii" receipt must be unbuildable;
 *  - a comment carrying a card-number/IP shape is refused on the phone with
 *    the same rule the server enforces (a rejected receipt that already left
 *    the device is itself a PII incident);
 *  - the body cannot be built without the row's concurrency token;
 *  - a 403 reads as the admin rule, never as a generic failure.
 */
import { describe, expect, it } from "vitest";

import {
  buildPiiDecisionBody,
  parsePiiFindingPage,
  piiDecisionProblem,
  piiFailureMessage,
  piiReasonLabel,
  piiStatusLabel,
  type PiiDecisionDraft,
} from "./subscriberPiiFindings";

const GOOD: PiiDecisionDraft = {
  outcome: "dismissed",
  reason: "false_positive",
  comment: "Loyalty code matches the SSN pattern but is store-issued.",
  evidenceReference: "ticket:DPO-123",
};

describe("parsePiiFindingPage", () => {
  it("reads the server's FindingPage shape", () => {
    const page = parsePiiFindingPage({
      items: [
        {
          id: "f-1",
          subscriber_id: "sub-9",
          field_name: "custom_fields.loyalty",
          detected_type: "ssn",
          confidence: 0.93,
          status: "pending",
          created_at: "2026-08-20T10:00:00Z",
          updated_at: "2026-08-20T10:00:00Z",
        },
      ],
      total: 41,
      page: 1,
      per_page: 50,
    });
    expect(page.total).toBe(41);
    expect(page.items[0]).toMatchObject({
      id: "f-1",
      subscriberId: "sub-9",
      fieldName: "custom_fields.loyalty",
      detectedType: "ssn",
      status: "pending",
      updatedAt: "2026-08-20T10:00:00Z",
      receipt: null,
    });
  });

  it("carries the review receipt when the row is decided", () => {
    const page = parsePiiFindingPage({
      items: [
        {
          id: "f-2",
          status: "dismissed",
          review_receipt: { reason: "test_data", comment: "Fixture rows." },
        },
      ],
      total: 1,
    });
    expect(page.items[0]?.receipt).toEqual({
      reason: "test_data",
      comment: "Fixture rows.",
    });
  });

  it("returns an empty page for junk", () => {
    expect(parsePiiFindingPage(null)).toEqual({ items: [], total: 0 });
    expect(parsePiiFindingPage({ items: [{ status: "pending" }] }).items).toEqual(
      [],
    );
  });
});

describe("piiDecisionProblem — mirrors NormalizeAndValidate", () => {
  it("accepts a whole receipt", () => {
    expect(piiDecisionProblem(GOOD)).toBeNull();
  });

  it("refuses a reason from the OTHER outcome's taxonomy", () => {
    expect(
      piiDecisionProblem({ ...GOOD, outcome: "reviewed" }),
    ).toMatch(/why this finding is being confirmed/);
    expect(
      piiDecisionProblem({
        ...GOOD,
        outcome: "dismissed",
        reason: "confirmed_pii",
      }),
    ).toMatch(/why this finding is being dismissed/);
  });

  it("requires a comment and refuses strong-PII shapes inside it", () => {
    expect(piiDecisionProblem({ ...GOOD, comment: " " })).toMatch(
      /Explain the decision/,
    );
    for (const smuggled of [
      "card was 4111 1111 1111 1111 in the field",
      "value came from 192.168.10.44",
      "seen at 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    ]) {
      expect(piiDecisionProblem({ ...GOOD, comment: smuggled })).toMatch(
        /must not contain raw personal data/,
      );
    }
  });

  it("requires a TYPED evidence reference, never a bare string", () => {
    for (const bad of ["", "DPO-123", "a:b", ":nope", "has space:ref"]) {
      expect(
        piiDecisionProblem({ ...GOOD, evidenceReference: bad }),
      ).toMatch(/typed evidence reference/);
    }
    expect(
      piiDecisionProblem({ ...GOOD, evidenceReference: "recording:call/812#4" }),
    ).toBeNull();
  });
});

describe("buildPiiDecisionBody", () => {
  it("builds the PATCH body the handler decodes, echoing the row's updated_at", () => {
    expect(buildPiiDecisionBody(GOOD, "2026-08-20T10:00:00Z")).toEqual({
      status: "dismissed",
      reason: "false_positive",
      comment: GOOD.comment,
      evidence_reference: "ticket:DPO-123",
      expected_updated_at: "2026-08-20T10:00:00Z",
    });
  });

  it("is null for an invalid draft AND for a missing concurrency token", () => {
    expect(buildPiiDecisionBody({ ...GOOD, reason: "" }, "2026-08-20T10:00:00Z")).toBeNull();
    expect(buildPiiDecisionBody(GOOD, "")).toBeNull();
    expect(buildPiiDecisionBody(GOOD, "not a date")).toBeNull();
  });
});

describe("copy honesty", () => {
  it("renders a 403 as the admin rule, and 409/412 as a concurrency fact", () => {
    expect(piiFailureMessage(403)).toMatch(/workspace administrators/);
    expect(piiFailureMessage(409)).toMatch(/already decided in another session/);
    expect(piiFailureMessage(500)).toMatch(/No decision was assumed/);
  });

  it("labels pending as work, and legacy receipts as what they are", () => {
    expect(piiStatusLabel("pending")).toBe("Needs review");
    expect(piiReasonLabel("legacy_migrated")).toMatch(/original rationale unavailable/);
    expect(piiReasonLabel("accepted_risk")).toBe("Accepted risk");
  });
});
