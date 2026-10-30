import { describe, expect, it } from "vitest";

import {
  attributeFieldLabel,
  changedByLabel,
  changeVerb,
  displayValue,
  isPiiField,
  NO_RECEIPTS_MESSAGE,
  parseConsentReceipts,
  parseRecordHistory,
  receiptEvidence,
  receiptHeadline,
} from "./subscriberRecordHistory";

describe("attributeFieldLabel", () => {
  it("humanises the scalar columns the server diffs", () => {
    expect(attributeFieldLabel("mailchimp_status")).toBe("Mailchimp status");
    expect(attributeFieldLabel("signup_ip")).toBe("Signup IP");
  });

  it("splits the jsonb map keys into bucket + key", () => {
    expect(attributeFieldLabel("custom_fields.plan")).toBe(
      "Custom field · plan",
    );
    expect(attributeFieldLabel("merge_fields.FNAME")).toBe(
      "Merge field · FNAME",
    );
  });

  it("falls back to the raw name rather than inventing one", () => {
    expect(attributeFieldLabel("some_new_column")).toBe("some_new_column");
    expect(attributeFieldLabel(undefined)).toBe("Unknown field");
  });
});

describe("isPiiField", () => {
  it("matches the server's own PII set", () => {
    for (const f of [
      "email",
      "first_name",
      "last_name",
      "full_name",
      "display_name",
      "signup_ip",
      "consent_source",
    ]) {
      expect(isPiiField(f)).toBe(true);
    }
  });

  it("treats every custom/merge field as PII-bearing", () => {
    expect(isPiiField("custom_fields.anything")).toBe(true);
    expect(isPiiField("merge_fields.X")).toBe(true);
  });

  it("does not flag the operational columns", () => {
    expect(isPiiField("status")).toBe(false);
    expect(isPiiField("locale")).toBe(false);
  });
});

describe("parseRecordHistory", () => {
  it("reads the page envelope and preserves NULL vs empty", () => {
    const out = parseRecordHistory({
      items: [
        {
          id: "h1",
          field_name: "status",
          old_value: null,
          new_value: "enabled",
          source: "api",
          changed_by: "ada@example.com",
          changed_at: "2026-02-01T00:00:00Z",
        },
      ],
      next_cursor: "2026-01-01T00:00:00Z",
    });
    expect(out.nextCursor).toBe("2026-01-01T00:00:00Z");
    expect(out.events[0]!.oldValue).toBeNull();
    expect(out.events[0]!.newValue).toBe("enabled");
  });

  it("drops a row with no field name", () => {
    expect(parseRecordHistory({ items: [{ id: "x" }] }).events).toEqual([]);
  });

  it("reports no cursor as null rather than an empty string", () => {
    expect(parseRecordHistory({ items: [] }).nextCursor).toBeNull();
    expect(parseRecordHistory(undefined).events).toEqual([]);
  });
});

describe("changeVerb + displayValue", () => {
  const base = {
    id: "1",
    field: "status",
    source: "api",
    changedBy: "",
    changedAt: null,
  };

  it("distinguishes Set / Cleared / Changed by NULL, not by emptiness", () => {
    expect(changeVerb({ ...base, oldValue: null, newValue: "a" })).toBe("Set");
    expect(changeVerb({ ...base, oldValue: "a", newValue: null })).toBe(
      "Cleared",
    );
    expect(changeVerb({ ...base, oldValue: "a", newValue: "b" })).toBe(
      "Changed",
    );
    // An empty STRING is a real value that was written, not an absence.
    expect(changeVerb({ ...base, oldValue: "a", newValue: "" })).toBe(
      "Changed",
    );
  });

  it("renders an absent value as an em-dash and an empty one as (empty)", () => {
    expect(displayValue(null)).toBe("—");
    expect(displayValue("")).toBe("(empty)");
    expect(displayValue("  ")).toBe("(empty)");
    expect(displayValue("enabled")).toBe("enabled");
  });

  it("attributes a system write rather than leaving it blank", () => {
    expect(
      changedByLabel({
        ...base,
        oldValue: null,
        newValue: "a",
        source: "",
        changedBy: "",
      }),
    ).toBe("System");
    expect(
      changedByLabel({
        ...base,
        oldValue: null,
        newValue: "a",
        source: "import",
        changedBy: "",
      }),
    ).toBe("import");
    expect(
      changedByLabel({
        ...base,
        oldValue: null,
        newValue: "a",
        source: "api",
        changedBy: "ada",
      }),
    ).toBe("ada · api");
  });
});

describe("consent receipts", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const email = "reader@example.com";
  const receipt = {
    id: "22222222-2222-4222-8222-222222222222",
    subscriber_email: email,
    new_state: "granted",
    source: "form",
    source_detail: "/signup",
    ip: "1.2.3.4",
    privacy_policy_version: "v3",
    at: "2026-01-01T00:00:00.000000Z",
    recorded_at: "2026-01-01T00:00:01.000000Z",
    kind: "proof",
  };
  const page = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 1,
    workspace_id: workspaceId,
    snapshot_at: "2026-01-01T00:01:00.000000Z",
    source_planes: ["consent_receipts", "consent_records"],
    receipts: [receipt],
    email,
    count: 1,
    has_more: false,
    ...overrides,
  });

  it("reads only a versioned workspace- and subject-bound page", () => {
    const out = parseConsentReceipts(page(), workspaceId, email);
    expect(out.count).toBe(1);
    expect(out.receipts[0]!.kind).toBe("proof");
    expect(out.receipts[0]!.recordedAt).toBe("2026-01-01T00:00:01.000000Z");
  });

  it("accepts the server-authenticated two-part continuation token", () => {
    const out = parseConsentReceipts(
      page({ has_more: true, next_cursor: "payload_part.signature_part" }),
      workspaceId,
      email,
    );
    expect(out.nextCursor).toBe("payload_part.signature_part");
  });

  it.each([
    ["missing envelope", null],
    ["wrong workspace", page({ workspace_id: "other-workspace" })],
    ["wrong subject", page({ email: "other@example.com" })],
    [
      "wrong row subject",
      page({
        receipts: [{ ...receipt, subscriber_email: "other@example.com" }],
      }),
    ],
    ["count mismatch", page({ count: 2 })],
    ["duplicate identity", page({ receipts: [receipt, receipt], count: 2 })],
    [
      "unsafe text",
      page({ receipts: [{ ...receipt, source: "form\u202Eliame" }] }),
    ],
    [
      "uppercase proof identity",
      page({
        receipts: [{ ...receipt, id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }],
      }),
    ],
    [
      "byte-order mark in source detail",
      page({ receipts: [{ ...receipt, source_detail: "form\uFEFFcapture" }] }),
    ],
    [
      "surrounding whitespace in source",
      page({ receipts: [{ ...receipt, source: " form" }] }),
    ],
    [
      "source exceeding its UTF-8 byte budget",
      page({ receipts: [{ ...receipt, source: "é".repeat(257) }] }),
    ],
    ["missing cursor", page({ has_more: true })],
    ["unsigned cursor", page({ has_more: true, next_cursor: "unsigned" })],
    [
      "non-canonical cursor",
      page({ has_more: true, next_cursor: "not=raw-url-safe" }),
    ],
  ])("rejects %s instead of smoothing it into evidence", (_name, raw) => {
    expect(() => parseConsentReceipts(raw, workspaceId, email)).toThrow(
      "could not be verified",
    );
  });

  it("headlines a first-ever consent without a phantom 'from'", () => {
    expect(
      receiptHeadline({
        id: "r1",
        prevState: "",
        newState: "subscribed",
        source: "",
        sourceDetail: "",
        ip: "",
        userAgent: "",
        policyVersion: "",
        capturedText: "",
        at: null,
        recordedAt: "2026-01-01T00:00:00Z",
        kind: "proof",
      }),
    ).toBe("subscribed");
  });

  it("names WHICH ledger a row came from", () => {
    const row = {
      id: "r1",
      prevState: "",
      newState: "subscribed",
      source: "form",
      sourceDetail: "/signup",
      ip: "1.2.3.4",
      userAgent: "",
      policyVersion: "v3",
      capturedText: "",
      at: null,
      recordedAt: "2026-01-01T00:00:00Z",
      kind: "proof" as const,
    };
    expect(receiptEvidence(row)).toContain("Proof of capture");
    expect(receiptEvidence({ ...row, kind: "receipt" })).toContain(
      "State change",
    );
    expect(receiptEvidence(row)).toContain("Policy v3");
  });

  it("does not present an empty ledger as proof of no consent", () => {
    expect(NO_RECEIPTS_MESSAGE).toMatch(/not proof they never opted in/i);
  });
});
