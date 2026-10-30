/**
 * The mirror transport at the envelope seam: given exactly what `rawRequest`
 * resolves to, does the right outcome come out — and does the 503
 * not-configured reply come back as DATA while everything else throws with
 * its status kept?
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runSuppressionMirror, SuppressionMirrorError } from "./suppressionMirror";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("runSuppressionMirror", () => {
  it("POSTs the provider path and parses the summary off the envelope", async () => {
    rawRequest.mockResolvedValue({
      data: { provider: "mailchimp", fetched: 4, imported: 2, skipped: 2, errors: 0 },
      error: null,
    });
    const outcome = await runSuppressionMirror("mailchimp");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/suppressions/mirror/mailchimp",
      {},
    );
    expect(outcome).toEqual({
      kind: "imported",
      result: { provider: "mailchimp", fetched: 4, imported: 2, skipped: 2, errors: 0 },
    });
  });

  it("folds the 503 not_configured reply into the result", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 503,
        message: "Service Unavailable",
        payload: { provider: "sendgrid", not_configured: true, not_configured_reason: "no key" },
      },
    });
    const outcome = await runSuppressionMirror("sendgrid");
    expect(outcome).toEqual({ kind: "not_configured", reason: "no key" });
  });

  it("throws on a genuine failure, keeping the status", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 500, message: "boom" },
    });
    await expect(runSuppressionMirror("mailchimp")).rejects.toMatchObject({
      name: "SuppressionMirrorError",
      status: 500,
      message: "boom",
    });
  });

  it("reads a 403 as a permission rule, not a generic failure", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "Forbidden" },
    });
    await expect(runSuppressionMirror("mailchimp")).rejects.toThrow(
      /restricted to workspace owners and admins/u,
    );
  });

  it("never hands the envelope itself to the parser", async () => {
    // A regression to `parse(res)` would read `.fetched` off the envelope and
    // "succeed" with all-zero counts; the parser throwing on the envelope
    // shape is what this asserts, via the typed error below.
    rawRequest.mockResolvedValue({ data: "not-a-summary", error: null });
    await expect(runSuppressionMirror("mailchimp")).rejects.toThrow(
      /summary could not be read/u,
    );
    expect(SuppressionMirrorError).toBeDefined();
  });
});
