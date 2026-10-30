/**
 * The check-batch transport seam: the addresses reach the wire as {emails},
 * and the envelope's error becomes a THROW — a failed check must never
 * render as a clean validation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

// eslint-disable-next-line import/first
import { checkEmailBatch } from "./subscribersValidateEmails";

beforeEach(() => rawRequest.mockReset());

describe("POST /email-validation/check-batch", () => {
  it("sends {emails} and returns the unwrapped body", async () => {
    rawRequest.mockResolvedValue({
      data: { results: [], summary: { total: 0, valid: 0, invalid: 0 } },
      error: null,
    });
    await expect(checkEmailBatch(["a@x.com", "b@y.com"])).resolves.toEqual({
      results: [],
      summary: { total: 0, valid: 0, invalid: 0 },
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/email-validation/check-batch",
      { emails: ["a@x.com", "b@y.com"] },
    );
  });

  it("throws the envelope's error", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "admin only", status: 403 },
    });
    await expect(checkEmailBatch(["a@x.com"])).rejects.toMatchObject({
      message: "admin only",
      status: 403,
    });
  });
});
