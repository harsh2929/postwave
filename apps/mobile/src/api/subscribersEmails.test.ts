/**
 * The multi-email transport's two-token discipline, pinned at the seam:
 * POST binds to a FRESH profile revision; PATCH/DELETE bind to the ADDRESS
 * revision the operator saw — and both refuse to write without a token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

// eslint-disable-next-line import/first
import {
  addSubscriberEmail,
  deleteSubscriberEmail,
  listSubscriberEmails,
  updateSubscriberEmail,
} from "./subscribersEmails";

beforeEach(() => rawRequest.mockReset());

describe("POST /subscribers/{id}/emails", () => {
  it("re-reads the profile and sends its version as If-Match", async () => {
    rawRequest
      .mockResolvedValueOnce({ data: { version: '"p9"' }, error: null })
      .mockResolvedValueOnce({ data: { id: "em-2" }, error: null });
    await addSubscriberEmail("sub-1", { email: "work@acme.dev" });
    expect(rawRequest.mock.calls[0]).toEqual([
      "GET",
      "/api/v1/subscribers/sub-1",
    ]);
    expect(rawRequest.mock.calls[1]).toEqual([
      "POST",
      "/api/v1/subscribers/sub-1/emails",
      { email: "work@acme.dev" },
      { headers: { "If-Match": '"p9"' } },
    ]);
  });

  it("refuses to attach when the deployment returns no revision", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await expect(
      addSubscriberEmail("sub-1", { email: "work@acme.dev" }),
    ).rejects.toThrow(/can't be attached safely/);
  });
});

describe("PATCH/DELETE /subscribers/{id}/emails/{email_id}", () => {
  it("sends the ADDRESS version the operator saw, never a re-read", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await updateSubscriberEmail("sub-1", "em-2", '"a4"', {
      suppressed: true,
      suppression_reason: "manual hold",
    });
    expect(rawRequest).toHaveBeenCalledTimes(1);
    expect(rawRequest.mock.calls[0]).toEqual([
      "PATCH",
      "/api/v1/subscribers/sub-1/emails/em-2",
      { suppressed: true, suppression_reason: "manual hold" },
      { headers: { "If-Match": '"a4"' } },
    ]);
  });

  it("refuses a write without the row token, on-device", async () => {
    await expect(
      updateSubscriberEmail("sub-1", "em-2", "", { suppressed: true }),
    ).rejects.toThrow(/missing its revision token/);
    await expect(deleteSubscriberEmail("sub-1", "em-2", "")).rejects.toThrow(
      /missing its revision token/,
    );
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("surfaces the envelope's error as a throw", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "precondition failed", status: 412 },
    });
    await expect(
      deleteSubscriberEmail("sub-1", "em-2", '"a4"'),
    ).rejects.toMatchObject({ status: 412 });
  });
});

describe("GET /subscribers/{id}/emails", () => {
  it("unwraps the envelope", async () => {
    rawRequest.mockResolvedValue({ data: { items: [] }, error: null });
    await expect(listSubscriberEmails("sub 1")).resolves.toEqual({ items: [] });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/subscribers/sub%201/emails",
    );
  });
});
