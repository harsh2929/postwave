import { describe, expect, it } from "vitest";

import {
  decodeWebhookPlaygroundEventCatalog,
  decodeWebhookPlaygroundFireReceipt,
} from "../../lib/api/webhook-playground-contract";

const fireId = "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6d";

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    fire_id: fireId,
    webhook_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    event_type: "legacy.retired",
    delivery_id: `playground-${fireId}`,
    state: "receipt_expired",
    outcome: "receiver_responded",
    receiver_status_code: 202,
    response_body_truncated: true,
    created_at: "2026-07-23T15:30:00.000Z",
    completed_at: "2026-07-23T15:30:01.000Z",
    ...overrides,
  };
}

describe("webhook playground receipt contract", () => {
  it("decodes an expired terminal receipt with its retained outcome evidence", () => {
    expect(decodeWebhookPlaygroundFireReceipt(receipt())).toEqual(receipt());
  });

  it("keeps historical receipt events readable without weakening the current catalog", () => {
    expect(decodeWebhookPlaygroundFireReceipt(receipt()).event_type).toBe(
      "legacy.retired",
    );
    expect(() =>
      decodeWebhookPlaygroundEventCatalog({
        events: [{ event_type: "legacy.retired", sample_payload: {} }],
      }),
    ).toThrow(/not in the canonical outbound webhook catalog/u);
  });

  it("accepts an expired receipt whose retained outcome was transport-ambiguous", () => {
    const expired = receipt({
      outcome: "transport_ambiguous",
      receiver_status_code: 0,
      response_body_truncated: false,
    });

    expect(decodeWebhookPlaygroundFireReceipt(expired)).toEqual(expired);
  });

  it.each([
    ["an empty terminal outcome", { outcome: "" }],
    ["a null completion time", { completed_at: null }],
    ["an impossible receiver status", { receiver_status_code: 0 }],
    [
      "an impossible ambiguous status",
      { outcome: "transport_ambiguous", receiver_status_code: 202 },
    ],
  ])("rejects receipt_expired with %s", (_label, overrides) => {
    expect(() =>
      decodeWebhookPlaygroundFireReceipt(receipt(overrides)),
    ).toThrow(/internally inconsistent/u);
  });

  it.each([
    "Legacy.Retired",
    "legacy retired",
    "legacy..retired",
    " legacy.retired",
  ])("rejects a non-canonical historical event token %s", (eventType) => {
    expect(() =>
      decodeWebhookPlaygroundFireReceipt(receipt({ event_type: eventType })),
    ).toThrow(/bounded canonical event token/u);
  });
});
