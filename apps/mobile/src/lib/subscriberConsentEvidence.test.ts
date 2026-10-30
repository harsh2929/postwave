/**
 * The consent-evidence envelope is the compliance contract of two writes
 * (status re-enable and channel-consent set), so these tests pin the exact
 * wire keys, the resubscribe source restriction, and the "no half envelope"
 * rule.
 */
import { describe, expect, it } from "vitest";

import {
  buildChannelConsentBody,
  buildResubscribeConsentPatch,
  CONSENT_RESUBSCRIBE_SOURCES,
  consentEvidenceProblem,
  emptyConsentEvidenceDraft,
  type ConsentEvidenceDraft,
} from "./subscriberConsentEvidence";

const NOW = Date.parse("2026-08-28T12:00:00Z");

function completeDraft(
  overrides: Partial<ConsentEvidenceDraft> = {},
): ConsentEvidenceDraft {
  return {
    source: "double_optin",
    channel: "mobile",
    legalBasis: "consent",
    capturedAt: "2026-08-28T11:30:00Z",
    jurisdiction: "eu",
    evidence: "ticket:SUP-1234",
    reason: "Subscriber asked to be re-enabled on a support call.",
    policyVersion: "privacy-2026-05",
    ...overrides,
  };
}

describe("consentEvidenceProblem", () => {
  it("accepts a complete grant draft", () => {
    expect(
      consentEvidenceProblem(completeDraft(), { requireEvidence: true }, NOW),
    ).toBeNull();
  });

  it("walks the first unmet requirement, one sentence at a time", () => {
    const empty = emptyConsentEvidenceDraft(new Date(NOW));
    expect(
      consentEvidenceProblem(empty, { requireEvidence: true }, NOW),
    ).toMatch(/reviewed opt-in record/);
    expect(
      consentEvidenceProblem(
        completeDraft({ legalBasis: "" }),
        { requireEvidence: true },
        NOW,
      ),
    ).toMatch(/legal basis/i);
    expect(
      consentEvidenceProblem(
        completeDraft({ jurisdiction: "eu!" }),
        { requireEvidence: true },
        NOW,
      ),
    ).toMatch(/jurisdiction/i);
    expect(
      consentEvidenceProblem(
        completeDraft({ reason: "  " }),
        { requireEvidence: true },
        NOW,
      ),
    ).toMatch(/why this change/i);
    expect(
      consentEvidenceProblem(
        completeDraft({ policyVersion: "" }),
        { requireEvidence: true },
        NOW,
      ),
    ).toMatch(/policy version/i);
  });

  it("refuses a captured time in the future", () => {
    expect(
      consentEvidenceProblem(
        completeDraft({ capturedAt: "2026-08-28T13:00:00Z" }),
        { requireEvidence: true },
        NOW,
      ),
    ).toMatch(/future/);
  });

  it("requires a durable evidence reference for a grant but not a revoke", () => {
    const noEvidence = completeDraft({ evidence: "" });
    expect(
      consentEvidenceProblem(noEvidence, { requireEvidence: true }, NOW),
    ).toMatch(/evidence/i);
    expect(
      consentEvidenceProblem(noEvidence, { requireEvidence: false }, NOW),
    ).toBeNull();
  });
});

describe("buildResubscribeConsentPatch", () => {
  it("emits desktop's SubscriberEnableConsentInput, key for key", () => {
    expect(buildResubscribeConsentPatch(completeDraft(), NOW)).toEqual({
      status: "enabled",
      consent_source: "double_optin",
      consent_timestamp: "2026-08-28T11:30:00.000Z",
      consent_channel: "mobile",
      consent_legal_basis: "consent",
      consent_jurisdiction: "EU",
      consent_evidence: "ticket:SUP-1234",
      consent_reason: "Subscriber asked to be re-enabled on a support call.",
      consent_policy_version: "privacy-2026-05",
    });
  });

  it("refuses provenance outside the reviewed opt-in subset", () => {
    // Valid for a CHANNEL consent, but not for an email-marketing re-enable.
    expect(
      buildResubscribeConsentPatch(
        completeDraft({ source: "preference_center" }),
        NOW,
      ),
    ).toBeNull();
    expect(
      CONSENT_RESUBSCRIBE_SOURCES.map((option) => option.value),
    ).toEqual(["double_optin", "single_optin"]);
  });

  it("never emits half an envelope", () => {
    expect(
      buildResubscribeConsentPatch(completeDraft({ reason: "" }), NOW),
    ).toBeNull();
    expect(
      buildResubscribeConsentPatch(completeDraft({ evidence: "" }), NOW),
    ).toBeNull();
  });
});

describe("buildChannelConsentBody", () => {
  it("emits the server's UpdateChannelConsentInput keys", () => {
    expect(
      buildChannelConsentBody(
        completeDraft({ source: "preference_center" }),
        "opted_in",
        NOW,
      ),
    ).toEqual({
      status: "opted_in",
      consent_source: "preference_center",
      consent_timestamp: "2026-08-28T11:30:00.000Z",
      evidence_channel: "mobile",
      legal_basis: "consent",
      evidence: "ticket:SUP-1234",
      jurisdiction: "EU",
      reason: "Subscriber asked to be re-enabled on a support call.",
      policy_version: "privacy-2026-05",
    });
  });

  it("allows a revoke without a durable opt-in artifact, but not a grant", () => {
    const noEvidence = completeDraft({ evidence: "" });
    expect(buildChannelConsentBody(noEvidence, "opted_in", NOW)).toBeNull();
    expect(
      buildChannelConsentBody(noEvidence, "opted_out", NOW),
    ).toMatchObject({ status: "opted_out", evidence: "" });
  });
});
