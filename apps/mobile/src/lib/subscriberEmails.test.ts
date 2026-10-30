/**
 * subscriberEmails — the SUB-016 rules: profile cap, duplicate refusal, the
 * consent patch mirroring desktop's update input key for key, and the
 * mandatory suppression reason.
 */
import { describe, expect, it } from "vitest";

import type { ConsentEvidenceDraft } from "@/lib/subscriberConsentEvidence";
import {
  MAX_EMAILS_PER_PROFILE,
  addEmailProblem,
  buildAddEmailBody,
  buildEmailConsentPatch,
  buildEmailSuppressionPatch,
  emailConsentLabel,
  parseSubscriberEmails,
} from "./subscriberEmails";

const ROW = {
  id: "em-1",
  email: "ada@acme.dev",
  isPrimary: true,
  consentStatus: "subscribed",
  suppressed: false,
  version: '"v3"',
};

describe("parseSubscriberEmails", () => {
  it("parses the {items} body, keeping the version token", () => {
    expect(
      parseSubscriberEmails({
        items: [
          {
            id: "em-1",
            email: "ada@acme.dev",
            is_primary: true,
            consent_status: "subscribed",
            suppressed: false,
            version: '"v3"',
          },
          { id: "", email: "junk@x.com" }, // no id → dropped
        ],
      }),
    ).toEqual([ROW]);
  });

  it("returns [] for junk", () => {
    expect(parseSubscriberEmails(null)).toEqual([]);
  });
});

describe("addEmailProblem", () => {
  it("refuses past the profile cap, invalid syntax, and duplicates", () => {
    const five = Array.from({ length: MAX_EMAILS_PER_PROFILE }, (_, i) => ({
      ...ROW,
      id: `em-${i}`,
      email: `a${i}@x.com`,
    }));
    expect(addEmailProblem(five, "new@x.com")).toMatch(/at most 5 addresses/);
    expect(addEmailProblem([ROW], "not-an-email")).toMatch(/valid email/);
    expect(addEmailProblem([ROW], "ADA@ACME.DEV")).toMatch(/already on/);
    expect(addEmailProblem([ROW], "work@acme.dev")).toBeNull();
  });
});

describe("wire bodies", () => {
  const draft: ConsentEvidenceDraft = {
    source: "preference_center",
    channel: "mobile",
    legalBasis: "consent",
    capturedAt: "2026-08-30T10:00:00.000Z",
    jurisdiction: "eu",
    evidence: "ticket #99",
    reason: "asked on the call",
    policyVersion: "2026-05",
  };

  it("the add body carries the address alone — consent is a separate reviewed step", () => {
    expect(buildAddEmailBody("  work@acme.dev ")).toEqual({
      email: "work@acme.dev",
    });
  });

  it("the consent patch mirrors SubscriberEmailUpdateInput key for key", () => {
    expect(buildEmailConsentPatch("unsubscribed", draft)).toEqual({
      consent_status: "unsubscribed",
      source: "preference_center",
      channel: "mobile",
      legal_basis: "consent",
      occurred_at: "2026-08-30T10:00:00.000Z",
      jurisdiction: "EU",
      evidence: "ticket #99",
    });
  });

  it("the suppression patch demands a reason — null without one", () => {
    expect(buildEmailSuppressionPatch(true, "  ")).toBeNull();
    expect(buildEmailSuppressionPatch(true, "manual hold")).toEqual({
      suppressed: true,
      suppression_reason: "manual hold",
    });
  });
});

describe("emailConsentLabel", () => {
  it("labels the five states and passes unknowns through", () => {
    expect(emailConsentLabel("never_subscribed")).toBe("Never subscribed");
    expect(emailConsentLabel("unknown")).toBe("No recorded signal");
    expect(emailConsentLabel("quarantined")).toBe("quarantined");
  });
});
