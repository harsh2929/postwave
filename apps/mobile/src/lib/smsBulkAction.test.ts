import { describe, expect, it } from "vitest";

import {
  decodeSmsBulkActionReceipt,
  smsBulkRequestBody,
  smsBulkTargetsFrom,
} from "./smsBulkAction";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15552345678";
const PHONE_2 = "+15552345679";
const STATE_AT = "2026-08-20T10:00:00Z";

describe("smsBulkTargetsFrom", () => {
  it("carries each row's CAS token, null when the row has none", () => {
    expect(
      smsBulkTargetsFrom([
        { phoneE164: PHONE, stateUpdatedAt: STATE_AT },
        { phoneE164: PHONE_2 },
      ]),
    ).toEqual([
      { phoneE164: PHONE, expectedUpdatedAt: STATE_AT },
      { phoneE164: PHONE_2, expectedUpdatedAt: null },
    ]);
  });
});

describe("smsBulkRequestBody", () => {
  const target = { phoneE164: PHONE, expectedUpdatedAt: null };

  it("shapes archive without until and snooze with it", () => {
    expect(
      smsBulkRequestBody({ conversations: [target], action: "archive" }),
    ).toEqual({ conversations: [target], action: "archive" });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      smsBulkRequestBody({ conversations: [target], action: "snooze", until }),
    ).toEqual({ conversations: [target], action: "snooze", until });
  });

  it("refuses empty, oversized, duplicate, and invalid selections", () => {
    expect(() =>
      smsBulkRequestBody({ conversations: [], action: "archive" }),
    ).toThrow(/at least one/);
    expect(() =>
      smsBulkRequestBody({
        conversations: Array.from({ length: 201 }, (_, i) => ({
          phoneE164: `+1555234${String(5000 + i)}`,
          expectedUpdatedAt: null,
        })),
        action: "archive",
      }),
    ).toThrow(/200/);
    expect(() =>
      smsBulkRequestBody({ conversations: [target, target], action: "archive" }),
    ).toThrow(/twice/);
    expect(() =>
      smsBulkRequestBody({
        conversations: [{ phoneE164: "+4470000", expectedUpdatedAt: null }],
        action: "archive",
      }),
    ).toThrow(/valid \+1/);
    expect(() =>
      smsBulkRequestBody({
        conversations: [{ phoneE164: PHONE, expectedUpdatedAt: "not-a-date" }],
        action: "archive",
      }),
    ).toThrow(/lifecycle version/);
  });

  it("refuses snooze without a future deadline and unknown actions", () => {
    expect(() =>
      smsBulkRequestBody({ conversations: [target], action: "snooze" }),
    ).toThrow(/future/);
    expect(() =>
      smsBulkRequestBody({
        conversations: [target],
        action: "snooze",
        until: "2020-01-01T00:00:00Z",
      }),
    ).toThrow(/future/);
    expect(() =>
      smsBulkRequestBody({
        conversations: [target],
        action: "mark_read" as never,
      }),
    ).toThrow(/Unknown bulk action/);
  });
});

describe("decodeSmsBulkActionReceipt", () => {
  function receiptRow(over: Record<string, unknown> = {}) {
    return {
      ok: true,
      tenantId: TENANT,
      phoneE164: PHONE,
      action: "archive",
      archivedAt: "2026-08-21T10:00:00Z",
      stateUpdatedAt: "2026-08-21T10:00:00.000001Z",
      ...over,
    };
  }
  function receipt(over: Record<string, unknown> = {}) {
    return {
      ok: true,
      tenantId: TENANT,
      action: "archive",
      applied: 1,
      receipts: [receiptRow()],
      ...over,
    };
  }
  const expected = { tenantId: TENANT, action: "archive" as const, phones: [PHONE] };

  it("decodes an all-applied receipt", () => {
    const decoded = decodeSmsBulkActionReceipt(receipt(), expected);
    expect(decoded.applied).toBe(1);
    expect(decoded.receipts[0]?.phoneE164).toBe(PHONE);
    expect(decoded.receipts[0]?.stateUpdatedAt).toBe(
      "2026-08-21T10:00:00.000001Z",
    );
  });

  it("refuses another tenant, another action, or a count mismatch", () => {
    expect(() =>
      decodeSmsBulkActionReceipt(
        receipt({ tenantId: "99999999-9999-4999-8999-999999999999" }),
        expected,
      ),
    ).toThrow(/another tenant/);
    expect(() =>
      decodeSmsBulkActionReceipt(receipt({ action: "snooze" }), expected),
    ).toThrow(/another action/);
    expect(() =>
      decodeSmsBulkActionReceipt(receipt({ applied: 2 }), expected),
    ).toThrow(/disagree/);
    expect(() =>
      decodeSmsBulkActionReceipt(receipt(), { ...expected, phones: [PHONE, PHONE_2] }),
    ).toThrow(/disagrees with the selection/);
  });

  it("refuses a receipt naming an unselected conversation", () => {
    expect(() =>
      decodeSmsBulkActionReceipt(
        receipt({ receipts: [receiptRow({ phoneE164: PHONE_2 })] }),
        expected,
      ),
    ).toThrow(/unselected/);
  });
});
