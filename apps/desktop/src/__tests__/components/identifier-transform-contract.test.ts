import { describe, expect, it } from "vitest";

import {
  parseIdentifierTransformConfig,
  parseIdentifierTransformPreview,
} from "../../components/settings/identifier-transform-contract";

const config = {
  email_normalize_dots: false,
  email_normalize_plus: true,
  phone_e164_format: true,
  phone_default_region: "IN",
};

describe("identifier transform runtime contracts", () => {
  it("accepts complete config and preview envelopes", () => {
    expect(parseIdentifierTransformConfig(config)).toEqual(config);
    const preview = {
      config,
      email_input: "Ada+test@example.com",
      email_output: "ada@example.com",
      email_changed: true,
      phones: [
        {
          key: "phone",
          input: "9876543210",
          output: "+919876543210",
          changed: true,
        },
      ],
    };
    expect(parseIdentifierTransformPreview(preview)).toEqual(preview);
  });

  it("rejects incomplete successful responses", () => {
    expect(parseIdentifierTransformConfig({})).toBeNull();
    expect(parseIdentifierTransformPreview({})).toBeNull();
    expect(
      parseIdentifierTransformPreview({
        config,
        email_input: "a@example.com",
        email_output: "a@example.com",
        email_changed: false,
      }),
    ).toBeNull();
  });
});
