import { describe, expect, it } from "vitest";

import {
  queuedResult,
  queueReceiptMessage,
  type ApiOk,
  type ApiQueued,
  type QueueReceipt,
  type QueueableApiResult,
} from "../../lib/api/result";

const receipt: QueueReceipt = {
  queueId: "mut_1",
  queuedAt: "2026-07-16T00:00:00.000Z",
  state: "pending",
  resource: "forms",
  action: "Update form",
  record: "Newsletter",
};

// Compile-time regression gates: a receipt cannot satisfy a domain success,
// and adding a synthetic domain payload to a queued result is rejected.
const queuedForTypeCheck: ApiQueued = queuedResult(receipt);
// @ts-expect-error A queue receipt is not a server-created Form.
const notAForm: ApiOk<{ id: string }> = queuedForTypeCheck;
const invalidQueued: ApiQueued = {
  queued: true,
  receipt,
  // @ts-expect-error Queued results intentionally have no domain data.
  data: { id: "mut_1" },
};
void notAForm;
void invalidQueued;

describe("API offline result contract", () => {
  it("returns a receipt-only discriminated queued result", () => {
    const result: QueueableApiResult<{ id: string }> = queuedResult(receipt);

    expect(result).toEqual({ queued: true, receipt });
    expect(result).not.toHaveProperty("data");
    expect(queueReceiptMessage(receipt)).toBe(
      "Update form saved on this device · pending sync",
    );
  });
});
