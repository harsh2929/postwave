/**
 * The transport seam. `rawRequest` returns the {data, error} envelope; a
 * parser test plus a mocked-hook test leave the api function itself — the
 * path it builds, the params it sends, the error it throws — uncovered.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./request", () => ({ rawRequest: vi.fn() }));

const { rawRequest } = await import("./request");
const { listWebhookDeliveries, OUTBOUND_ENDPOINT_DELIVERIES_LIMIT } =
  await import("./outboundWebhookDeliveries");

describe("listWebhookDeliveries", () => {
  it("GETs the per-endpoint route with the server's default page size", async () => {
    vi.mocked(rawRequest).mockResolvedValueOnce({
      data: { deliveries: [], next_cursor: "" },
      error: null,
    } as never);

    const page = await listWebhookDeliveries("id/with space");

    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      `/api/v1/outbound-webhooks/id%2Fwith%20space/deliveries?limit=${OUTBOUND_ENDPOINT_DELIVERIES_LIMIT}`,
    );
    expect(page).toEqual({ deliveries: [], nextCursor: "" });
  });

  it("forwards the cursor for the next page and clamps limit to the server ceiling", async () => {
    vi.mocked(rawRequest).mockResolvedValueOnce({
      data: { deliveries: [], next_cursor: "" },
      error: null,
    } as never);

    await listWebhookDeliveries("w1", { cursor: "eyJ0IjoxfQ==", limit: 9_999 });

    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/outbound-webhooks/w1/deliveries?limit=200&cursor=eyJ0IjoxfQ%3D%3D",
    );
  });

  it("omits an empty cursor and floors a nonsense limit at 1", async () => {
    vi.mocked(rawRequest).mockResolvedValueOnce({
      data: [],
      error: null,
    } as never);

    await listWebhookDeliveries("w1", { cursor: "", limit: -5 });

    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/outbound-webhooks/w1/deliveries?limit=1",
    );
  });

  it("normalises the rows through the shared page parser", async () => {
    vi.mocked(rawRequest).mockResolvedValueOnce({
      data: {
        deliveries: [
          {
            id: "d-1",
            webhook_id: "w1",
            event_type: "campaign.sent",
            attempt_count: 2,
            status: "delivered",
            created_at: "2026-09-01T00:00:00Z",
            delivered_at: "2026-09-01T00:00:03Z",
          },
        ],
        next_cursor: "abc",
      },
      error: null,
    } as never);

    const page = await listWebhookDeliveries("w1");

    expect(page.nextCursor).toBe("abc");
    expect(page.deliveries).toEqual([
      {
        id: "d-1",
        webhook_id: "w1",
        event_type: "campaign.sent",
        attempt_count: 2,
        status: "delivered",
        created_at: "2026-09-01T00:00:00Z",
        delivered_at: "2026-09-01T00:00:03Z",
      },
    ]);
  });

  it("throws the server's own message, with the status inspectable", async () => {
    vi.mocked(rawRequest).mockResolvedValueOnce({
      data: null,
      error: { status: 404, message: "webhook not found" },
    } as never);

    await expect(listWebhookDeliveries("gone")).rejects.toMatchObject({
      message: "webhook not found",
      status: 404,
    });
  });

  it("falls back to a stated failure when the server sent no message", async () => {
    vi.mocked(rawRequest).mockResolvedValueOnce({
      data: null,
      error: { status: 500, message: "" },
    } as never);

    await expect(listWebhookDeliveries("w1")).rejects.toThrow(
      "Couldn't load this endpoint's deliveries.",
    );
  });
});
