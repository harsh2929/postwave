import { describe, expect, it } from "vitest";

import {
  consentEvidenceError,
  consentEvidencePayload,
  emptyConsentEvidenceDraft,
  type ConsentEvidenceDraft,
} from "../../components/subscribers/consent-evidence";

function completeDraft(): ConsentEvidenceDraft {
  return {
    source: "double_optin",
    channel: "email",
    legalBasis: "consent",
    occurredAt: "2026-01-02T10:30:00.000Z",
    jurisdiction: " gb ",
    evidence: " receipt:consent-123 ",
    reason: " Reviewed the double opt-in receipt. ",
    policyVersion: " privacy-2026-01 ",
    scopeAcknowledged: true,
    confirmation: "GRANT 2",
  };
}

describe("consent evidence", () => {
  it("rejects empty and invented provenance instead of inferring consent", () => {
    expect(
      consentEvidenceError(emptyConsentEvidenceDraft(), {
        requireEvidence: true,
        requireScope: true,
      }),
    ).toBe("Select where the evidence came from.");

    const invented = completeDraft();
    invented.source = "admin_import";
    expect(
      consentEvidenceError(invented, {
        requireEvidence: true,
        requireScope: true,
      }),
    ).toBe("Select where the evidence came from.");
  });

  it("canonicalizes a complete, reviewable evidence payload", () => {
    const draft = completeDraft();
    expect(
      consentEvidenceError(draft, {
        requireEvidence: true,
        requireScope: true,
      }),
    ).toBeNull();
    expect(consentEvidencePayload(draft)).toEqual({
      source: "double_optin",
      channel: "email",
      legal_basis: "consent",
      occurred_at: "2026-01-02T10:30:00.000Z",
      jurisdiction: "GB",
      evidence: "receipt:consent-123",
      reason: "Reviewed the double opt-in receipt.",
      policy_version: "privacy-2026-01",
    });
  });

  it("requires durable grant evidence and exact-scope acknowledgement", () => {
    const noEvidence = completeDraft();
    noEvidence.evidence = "";
    expect(
      consentEvidenceError(noEvidence, {
        requireEvidence: true,
        requireScope: true,
      }),
    ).toBe("Enter a durable evidence reference.");

    const noScope = completeDraft();
    noScope.scopeAcknowledged = false;
    expect(
      consentEvidenceError(noScope, {
        requireEvidence: true,
        requireScope: true,
      }),
    ).toBe("Review and acknowledge the exact scope before continuing.");
  });

  it("rejects future-dated decisions", () => {
    const draft = completeDraft();
    draft.occurredAt = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(
      consentEvidenceError(draft, {
        requireEvidence: true,
        requireScope: true,
      }),
    ).toBe("The captured time cannot be in the future.");
  });
});
