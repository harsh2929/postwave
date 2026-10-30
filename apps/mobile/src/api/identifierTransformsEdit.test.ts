/** Transport seam for the identifier-transforms write and dry-run. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  previewIdentifierTransforms,
  updateIdentifierTransforms,
} from "./identifierTransformsEdit";
import { PlatformConfigError } from "./platformConfig";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("updateIdentifierTransforms", () => {
  it("PATCHes only the fields it was given and normalizes the stored config", async () => {
    rawRequest.mockResolvedValue({
      data: {
        email_normalize_dots: false,
        email_normalize_plus: false,
        phone_e164_format: true,
        phone_default_region: "gb",
      },
      error: null,
    });
    const res = await updateIdentifierTransforms({ email_normalize_plus: false });
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/settings/identifier-transforms",
      { email_normalize_plus: false },
    );
    expect(res).toEqual({
      emailNormalizeDots: false,
      emailNormalizePlus: false,
      phoneE164Format: true,
      phoneDefaultRegion: "GB",
    });
  });

  it("throws a status-typed error carrying the server's invalid_region sentence", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 422,
        code: "invalid_region",
        message:
          "phone_default_region must be a known ISO 3166-1 alpha-2 region (or empty)",
      },
    });
    const failure = await updateIdentifierTransforms({
      phone_default_region: "ZZ",
    }).catch((e) => e);
    expect(failure).toBeInstanceOf(PlatformConfigError);
    expect(failure.status).toBe(422);
    expect(failure.message).toBe(
      "phone_default_region must be a known ISO 3166-1 alpha-2 region (or empty)",
    );
  });
});

describe("previewIdentifierTransforms", () => {
  const BODY = {
    email: "J.o.h.n+promo@Gmail.com",
    custom_fields: { phone: "(202) 555-0147" },
    overrides: {
      email_normalize_dots: true,
      email_normalize_plus: true,
      phone_e164_format: true,
      phone_default_region: "US",
    },
  };

  it("POSTs the draft as `overrides` and reads the before/after lines", async () => {
    rawRequest.mockResolvedValue({
      data: {
        config: BODY.overrides,
        email_input: "J.o.h.n+promo@Gmail.com",
        email_output: "john@gmail.com",
        email_changed: true,
        phones: [
          { key: "phone", input: "(202) 555-0147", output: "+12025550147", changed: true },
        ],
      },
      error: null,
    });
    const res = await previewIdentifierTransforms(BODY);
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/subscribers/preview-transforms",
      BODY,
    );
    expect(res).toEqual({
      email: {
        key: "email",
        input: "J.o.h.n+promo@Gmail.com",
        output: "john@gmail.com",
        changed: true,
      },
      phones: [
        { key: "phone", input: "(202) 555-0147", output: "+12025550147", changed: true },
      ],
    });
  });

  it("refuses a body that is not the preview shape instead of showing an empty preview", async () => {
    rawRequest.mockResolvedValue({ data: { items: [], total: 0 }, error: null });
    await expect(previewIdentifierTransforms(BODY)).rejects.toThrow(
      "Preview response was malformed.",
    );
  });

  it("throws a status-typed error on 403", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "" },
    });
    const failure = await previewIdentifierTransforms(BODY).catch((e) => e);
    expect(failure).toBeInstanceOf(PlatformConfigError);
    expect(failure.status).toBe(403);
    expect(failure.message).toBe("Couldn't preview the identifier rules.");
  });
});
