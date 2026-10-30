import { describe, expect, it, vi } from "vitest";

vi.mock("./request", () => ({ rawRequest: vi.fn() }));

const { rawRequest } = await import("./request");
const { testOutboundWebhook } = await import("./settings");

describe("testOutboundWebhook", () => {
  it("sends only the bounded canned test to the selected endpoint", async () => {
    vi.mocked(rawRequest).mockResolvedValueOnce({
      data: { status_code: 202, signed: true },
      error: null,
    } as never);

    await testOutboundWebhook("endpoint/with space");

    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/outbound-webhooks/endpoint%2Fwith%20space/test",
      {},
    );
  });
});
