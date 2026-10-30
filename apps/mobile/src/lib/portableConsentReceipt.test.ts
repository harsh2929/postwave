import { describe, expect, it } from "vitest";

import {
  activePurposeCount,
  parsePortableReceipt,
  purposeLabel,
  receiptFilename,
  receiptSummary,
} from "./portableConsentReceipt";

/** A minimal but wire-accurate Kantara CR v1.1 document. */
const RECEIPT = {
  version: "KI-CR-v1.1",
  jurisdiction: "ISO/IEC 27560",
  consentReceiptID: "prof_123",
  consentTimestamp: "2026-07-25T10:00:00Z",
  piiPrincipalId: "ada@example.com",
  subjectProfileId: "prof_123",
  piiController: {
    piiControllerName: "Acme Ltd",
    contact: "dpo@acme.test",
  },
  policyUri: "https://acme.test/privacy",
  services: [
    {
      purpose: "email_marketing",
      consentType: "EXPLICIT",
      active: true,
      grantedAt: "2026-01-04T09:00:00Z",
    },
    { purpose: "sms_marketing", consentType: "EXPLICIT", active: false },
  ],
  history: [
    { newState: "granted", source: "form", at: "2026-01-04T09:00:00Z" },
    { newState: "revoked", source: "portal", at: "2026-03-01T09:00:00Z" },
  ],
};

describe("parsePortableReceipt", () => {
  it("reads the Kantara camelCase field names the server actually emits", () => {
    const receipt = parsePortableReceipt(RECEIPT);
    expect(receipt).not.toBeNull();
    expect(receipt?.version).toBe("KI-CR-v1.1");
    expect(receipt?.receiptId).toBe("prof_123");
    expect(receipt?.subjectEmail).toBe("ada@example.com");
    expect(receipt?.controllerName).toBe("Acme Ltd");
    expect(receipt?.controllerContact).toBe("dpo@acme.test");
    expect(receipt?.policyUri).toBe("https://acme.test/privacy");
    expect(receipt?.historyCount).toBe(2);
  });

  it("returns null rather than an empty receipt for a non-document", () => {
    expect(parsePortableReceipt(null)).toBeNull();
    expect(parsePortableReceipt("nope")).toBeNull();
    expect(parsePortableReceipt([])).toBeNull();
    // An object with neither a subject nor a receipt id proves nothing.
    expect(parsePortableReceipt({ version: "KI-CR-v1.1" })).toBeNull();
  });

  it("treats a missing grantedAt as absent, never as the epoch", () => {
    const receipt = parsePortableReceipt(RECEIPT);
    expect(receipt?.purposes[0]?.grantedAt).toBe("2026-01-04T09:00:00Z");
    expect(receipt?.purposes[1]?.grantedAt).toBe("");
  });

  it("treats a non-boolean `active` as NOT granted", () => {
    const receipt = parsePortableReceipt({
      ...RECEIPT,
      services: [{ purpose: "profiling", active: "yes" }],
    });
    expect(receipt?.purposes[0]?.active).toBe(false);
  });

  it("drops service entries without a purpose key", () => {
    const receipt = parsePortableReceipt({
      ...RECEIPT,
      services: [{ consentType: "EXPLICIT", active: true }, null],
    });
    expect(receipt?.purposes).toEqual([]);
  });

  it("rejects an unparseable timestamp instead of passing it through", () => {
    const receipt = parsePortableReceipt({
      ...RECEIPT,
      consentTimestamp: "whenever",
    });
    expect(receipt?.generatedAt).toBe("");
  });
});

describe("purposeLabel", () => {
  it("labels the known regulatory vocabulary", () => {
    expect(purposeLabel("email_marketing")).toBe("Email marketing");
    expect(purposeLabel("ai_processing")).toBe("AI processing");
  });

  it("returns an unknown purpose VERBATIM rather than inventing prose", () => {
    expect(purposeLabel("some_new_purpose")).toBe("some_new_purpose");
  });
});

describe("receiptSummary", () => {
  it("states granted-of-total and the change count", () => {
    const receipt = parsePortableReceipt(RECEIPT)!;
    expect(activePurposeCount(receipt)).toBe(1);
    expect(receiptSummary(receipt)).toBe(
      "1 of 2 purposes currently granted, 2 recorded changes.",
    );
  });

  it("says an empty consent vector is empty rather than showing 0 of 0", () => {
    const receipt = parsePortableReceipt({ ...RECEIPT, services: [] })!;
    expect(receiptSummary(receipt)).toBe(
      "No consent purposes are recorded for this person.",
    );
  });

  it("singularises a one-purpose, one-change receipt", () => {
    const receipt = parsePortableReceipt({
      ...RECEIPT,
      services: [{ purpose: "profiling", active: true }],
      history: [{ newState: "granted", source: "form", at: "2026-01-01T00:00:00Z" }],
    })!;
    expect(receiptSummary(receipt)).toBe(
      "1 of 1 purpose currently granted, 1 recorded change.",
    );
  });

  it("says 'no recorded changes' rather than '0 recorded changes'", () => {
    const receipt = parsePortableReceipt({ ...RECEIPT, history: [] })!;
    expect(receiptSummary(receipt)).toContain("no recorded changes");
  });
});

describe("receiptFilename", () => {
  it("mirrors the server's own ZIP naming so the two are recognisable", () => {
    const receipt = parsePortableReceipt(RECEIPT)!;
    expect(receiptFilename(receipt, "sub-9")).toBe(
      "subscriber-sub-9-consent-receipt-2026-07-25.json",
    );
  });

  it("falls back to the receipt id when the caller has no subscriber id", () => {
    const receipt = parsePortableReceipt(RECEIPT)!;
    expect(receiptFilename(receipt, "")).toBe(
      "subscriber-prof_123-consent-receipt-2026-07-25.json",
    );
  });
});
