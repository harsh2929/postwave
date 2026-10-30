// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  getDeduplicationSettings,
  normalizeDeduplicationSettings,
  normalizeIdentifierTransforms,
  normalizePiiConfig,
  previewIdentifierTransforms,
  updateDeduplicationSettings,
  updateIdentifierTransforms,
  updatePiiFields,
} from "@/lib/data-hygiene-api";

const transforms = {
  email_normalize_dots: true,
  email_normalize_plus: false,
  phone_e164_format: true,
  phone_default_region: "US",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("data-hygiene API parity", () => {
  it("uses the mounted methods, exact bodies, and online-only mutation policy", async () => {
    mocks.patch.mockResolvedValueOnce(transforms).mockResolvedValueOnce({
      built_in_fields: ["email", "phone"],
      fields: [
        {
          field_name: "government_identifier",
          sensitive: true,
          built_in: false,
        },
      ],
    });
    mocks.put.mockResolvedValue({ merge_confidence_threshold: 0.91 });
    mocks.post.mockResolvedValue({
      config: transforms,
      email_input: "J.o.h.n+promo@Example.test",
      email_output: "john+promo@example.test",
      email_changed: true,
      phones: [
        {
          key: "phone",
          input: "(202) 555-0147",
          output: "+12025550147",
          changed: true,
        },
      ],
    });

    await expect(updateIdentifierTransforms(transforms)).resolves.toEqual(
      transforms,
    );
    expect(mocks.patch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/settings/identifier-transforms",
      transforms,
      { requireOnline: true, maxAttempts: 1 },
    );

    await expect(
      previewIdentifierTransforms({
        email: "J.o.h.n+promo@Example.test",
        custom_fields: { phone: "(202) 555-0147" },
        overrides: transforms,
      }),
    ).resolves.toMatchObject({
      email_output: "john+promo@example.test",
      phones: [{ output: "+12025550147" }],
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/subscribers/preview-transforms",
      expect.objectContaining({ overrides: transforms }),
      { idempotencyKey: null, requireOnline: true },
    );

    await expect(updateDeduplicationSettings(0.91)).resolves.toEqual({
      merge_confidence_threshold: 0.91,
    });
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/v1/settings/deduplication",
      { merge_confidence_threshold: 0.91 },
      { requireOnline: true, maxAttempts: 1 },
    );

    await expect(
      updatePiiFields([
        { field_name: " Government_Identifier ", sensitive: true },
      ]),
    ).resolves.toMatchObject({
      fields: [{ field_name: "government_identifier", sensitive: true }],
    });
    expect(mocks.patch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/settings/pii-config",
      {
        fields: [{ field_name: "government_identifier", sensitive: true }],
      },
      { requireOnline: true, maxAttempts: 1 },
    );
  });

  it("rejects malformed policy reads instead of manufacturing safe-looking defaults", async () => {
    mocks.get.mockResolvedValue({ merge_confidence_threshold: "0.95" });
    await expect(getDeduplicationSettings()).rejects.toThrow(/malformed/i);
    expect(() => normalizeDeduplicationSettings({})).toThrow(/malformed/i);
    expect(() =>
      normalizeIdentifierTransforms({
        ...transforms,
        phone_default_region: "NOT-A-REGION",
      }),
    ).toThrow(/malformed/i);
    expect(() =>
      normalizePiiConfig({ built_in_fields: ["email"], fields: null }),
    ).toThrow(/malformed/i);
  });

  it("locks built-ins on and accepts the legacy field-key read shape without using it for writes", () => {
    expect(
      normalizePiiConfig({
        built_in_fields: ["Email", "phone"],
        fields: [
          {
            field_name: "email",
            sensitive: false,
            built_in: false,
          },
          { key: "government_identifier" },
        ],
      }),
    ).toEqual({
      built_in_fields: ["email", "phone"],
      fields: [
        { field_name: "email", sensitive: true, built_in: true },
        {
          field_name: "government_identifier",
          sensitive: null,
          built_in: false,
        },
      ],
    });
  });

  it("refuses empty PII updates before transport", async () => {
    await expect(updatePiiFields([])).rejects.toThrow(/at least one/i);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
