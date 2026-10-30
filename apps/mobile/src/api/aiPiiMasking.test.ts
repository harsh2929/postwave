/** Transport seam for the AI PII-masking config. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPiiMaskingConfig, patchPiiMaskingConfig } from "./aiPiiMasking";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("getPiiMaskingConfig", () => {
  it("GETs the settings route and normalizes the row shape", async () => {
    rawRequest.mockResolvedValue({
      data: {
        built_in_fields: ["email"],
        fields: [{ field_name: "company", sensitive: true, built_in: false }],
      },
      error: null,
    });
    const res = await getPiiMaskingConfig();
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/settings/pii-config");
    expect(res.error).toBeNull();
    expect(res.data?.fields.map((f) => f.fieldName)).toEqual(["email", "company"]);
  });

  it("passes the error envelope through untouched (the card branches on its code)", async () => {
    const error = { status: 503, code: "pii_gateway_unconfigured", message: "x" };
    rawRequest.mockResolvedValue({ data: null, error });
    const res = await getPiiMaskingConfig();
    expect(res).toEqual({ data: null, error });
  });
});

describe("patchPiiMaskingConfig", () => {
  it("PATCHes the batch body and returns the normalized new config", async () => {
    rawRequest.mockResolvedValue({
      data: { built_in_fields: [], fields: [{ field_name: "salary", sensitive: true }] },
      error: null,
    });
    const body = { fields: [{ field_name: "salary", sensitive: true }] };
    const res = await patchPiiMaskingConfig(body);
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/settings/pii-config",
      body,
    );
    expect(res.data?.fields).toEqual([
      { fieldName: "salary", sensitive: true, builtIn: false },
    ]);
  });
});
