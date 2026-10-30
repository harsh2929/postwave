/**
 * The bulk-paste transport seam: the RAW paste reaches the wire untouched
 * (the server owns the split), the status is pinned to "unconfirmed" (the
 * non-sendability stance), and the envelope's error becomes a THROW so a
 * refused paste can never read as an accepted one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

// eslint-disable-next-line import/first
import { bulkPasteSubscribers } from "./subscribersBulkPaste";

beforeEach(() => rawRequest.mockReset());

describe("POST /subscribers/bulk-paste", () => {
  it("sends the raw paste untouched, status pinned to unconfirmed", async () => {
    rawRequest.mockResolvedValue({ data: { parsed: 2 }, error: null });
    await bulkPasteSubscribers({
      emails: "a@x.com, b@y.com",
      tags: ["event-2026"],
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/subscribers/bulk-paste",
      {
        emails: "a@x.com, b@y.com",
        status: "unconfirmed",
        tags: ["event-2026"],
      },
    );
  });

  it("omits the tags key entirely for an untagged paste", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await bulkPasteSubscribers({ emails: "a@x.com", tags: [] });
    const body = rawRequest.mock.calls[0]![2] as Record<string, unknown>;
    expect("tags" in body).toBe(false);
  });

  it("throws the envelope's error", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "too many addresses", status: 422 },
    });
    await expect(
      bulkPasteSubscribers({ emails: "a@x.com", tags: [] }),
    ).rejects.toMatchObject({ message: "too many addresses", status: 422 });
  });
});
