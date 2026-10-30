/**
 * The transport seam for the send sheet's verdict. The one fact worth a
 * test: the body carries NO campaign identity. verdict.go turns a lone
 * `campaign_id` into a failed campaign_assurance component, and that makes
 * every non-critical verdict read `incomplete` — so a key that quietly came
 * back here would break the feature while every parser test stayed green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestDraftPresendVerdict } from "./presendVerdictGate";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockResolvedValue({ data: {}, error: null });
});

describe("requestDraftPresendVerdict", () => {
  it("POSTs /api/v1/presend/verdict with subject/html/from and nothing else", async () => {
    await requestDraftPresendVerdict({
      subject: "s",
      html: "<p>x</p>",
      from: "news@acme.com",
    });
    expect(rawRequest).toHaveBeenCalledTimes(1);
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/presend/verdict", {
      subject: "s",
      html: "<p>x</p>",
      from: "news@acme.com",
    });
    const body = rawRequest.mock.calls[0]![2] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["from", "html", "subject"]);
    expect(body).not.toHaveProperty("campaign_id");
    expect(body).not.toHaveProperty("text");
  });

  it("hands the envelope back untouched — the reader decides what it means", async () => {
    const error = { status: 502, code: "upstream_unavailable", message: "down" };
    rawRequest.mockResolvedValueOnce({ data: null, error });
    const res = await requestDraftPresendVerdict({ subject: "", html: "<p>x</p>", from: "" });
    expect(res).toEqual({ data: null, error });
  });
});
