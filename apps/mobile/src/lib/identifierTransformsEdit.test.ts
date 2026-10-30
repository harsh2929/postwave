import { describe, expect, it } from "vitest";

import {
  IDENTIFIER_TRANSFORM_PHONE_REGIONS,
  identifierTransformsPatch,
  normalizeTransformPreview,
  previewLineText,
  previewRequestBody,
  transformChangeLines,
  validateIdentifierTransformsDraft,
  type IdentifierTransformsDraft,
} from "./identifierTransformsEdit";

const SERVER: IdentifierTransformsDraft = {
  emailNormalizeDots: false,
  emailNormalizePlus: true,
  phoneE164Format: false,
  phoneDefaultRegion: "",
};

describe("identifierTransformsPatch", () => {
  it("sends only the fields that differ from the server snapshot", () => {
    expect(
      identifierTransformsPatch(SERVER, { ...SERVER, emailNormalizeDots: true }),
    ).toEqual({ email_normalize_dots: true });
  });

  it("is null when nothing changed, so the sheet is not dirty", () => {
    expect(identifierTransformsPatch(SERVER, { ...SERVER })).toBeNull();
  });

  it("re-asserts a rule being switched OFF, not only ON", () => {
    // Pointer semantics: `false` must travel; omitting it would leave the
    // server's `true` in place.
    expect(
      identifierTransformsPatch(SERVER, { ...SERVER, emailNormalizePlus: false }),
    ).toEqual({ email_normalize_plus: false });
  });

  it("carries a region change alone, without re-sending the E.164 toggle", () => {
    expect(
      identifierTransformsPatch(
        { ...SERVER, phoneE164Format: true },
        { ...SERVER, phoneE164Format: true, phoneDefaultRegion: "GB" },
      ),
    ).toEqual({ phone_default_region: "GB" });
  });
});

describe("validateIdentifierTransformsDraft", () => {
  it("accepts an empty region and any two-letter code", () => {
    expect(validateIdentifierTransformsDraft(SERVER)).toBeNull();
    expect(
      validateIdentifierTransformsDraft({ ...SERVER, phoneDefaultRegion: "DE" }),
    ).toBeNull();
  });

  it("rejects a region that is not a two-letter code", () => {
    expect(
      validateIdentifierTransformsDraft({ ...SERVER, phoneDefaultRegion: "GBR" }),
    ).toBe("Default region must be a two-letter country code, or none.");
  });

  it("offers only regions the validator would accept", () => {
    for (const region of IDENTIFIER_TRANSFORM_PHONE_REGIONS) {
      expect(
        validateIdentifierTransformsDraft({
          ...SERVER,
          phoneDefaultRegion: region.value,
        }),
      ).toBeNull();
    }
  });
});

describe("previewRequestBody", () => {
  it("sends the draft as `overrides` in the server's snake_case", () => {
    expect(
      previewRequestBody(
        { ...SERVER, phoneE164Format: true, phoneDefaultRegion: "US" },
        " J.o.h.n+promo@Gmail.com ",
        "(202) 555-0147",
      ),
    ).toEqual({
      email: "J.o.h.n+promo@Gmail.com",
      custom_fields: { phone: "(202) 555-0147" },
      overrides: {
        email_normalize_dots: false,
        email_normalize_plus: true,
        phone_e164_format: true,
        phone_default_region: "US",
      },
    });
  });

  it("omits the phone field entirely when the sample is blank", () => {
    expect(previewRequestBody(SERVER, "a@b.c", "  ").custom_fields).toEqual({});
  });
});

describe("normalizeTransformPreview", () => {
  it("reads PreviewTransformResult off identifier_normalizer.go", () => {
    expect(
      normalizeTransformPreview({
        config: {},
        email_input: "J.o.h.n+promo@Gmail.com",
        email_output: "john@gmail.com",
        email_changed: true,
        phones: [
          {
            key: "phone",
            input: "(202) 555-0147",
            output: "+12025550147",
            changed: true,
          },
          { key: "", input: "x", output: "x", changed: false },
        ],
      }),
    ).toEqual({
      email: {
        key: "email",
        input: "J.o.h.n+promo@Gmail.com",
        output: "john@gmail.com",
        changed: true,
      },
      phones: [
        {
          key: "phone",
          input: "(202) 555-0147",
          output: "+12025550147",
          changed: true,
        },
      ],
    });
  });

  it("returns null for anything that is not the preview shape", () => {
    expect(normalizeTransformPreview(null)).toBeNull();
    expect(normalizeTransformPreview("<!DOCTYPE html>")).toBeNull();
    expect(normalizeTransformPreview([])).toBeNull();
    expect(normalizeTransformPreview({ items: [], total: 0 })).toBeNull();
    // `email_changed` as a string is not a boolean answer.
    expect(
      normalizeTransformPreview({
        email_input: "a",
        email_output: "a",
        email_changed: "false",
      }),
    ).toBeNull();
  });

  it("tolerates a missing phones array", () => {
    expect(
      normalizeTransformPreview({
        email_input: "a@b.c",
        email_output: "a@b.c",
        email_changed: false,
      })?.phones,
    ).toEqual([]);
  });
});

describe("previewLineText", () => {
  it("writes the arrow only when something changed", () => {
    expect(
      previewLineText({
        key: "email",
        input: "J.o.h.n+promo@Gmail.com",
        output: "john@gmail.com",
        changed: true,
      }),
    ).toBe("J.o.h.n+promo@Gmail.com → john@gmail.com");
  });

  it("says 'no change' in words rather than repeating the value silently", () => {
    expect(
      previewLineText({
        key: "email",
        input: "a@b.c",
        output: "a@b.c",
        changed: false,
      }),
    ).toBe("a@b.c (no change)");
  });

  it("never renders an empty input as nothing", () => {
    expect(
      previewLineText({ key: "email", input: "", output: "", changed: false }),
    ).toBe("— (no change)");
  });
});

describe("transformChangeLines", () => {
  it("restates each changed rule, on or off, and nothing else", () => {
    expect(
      transformChangeLines({
        email_normalize_dots: true,
        email_normalize_plus: false,
      }),
    ).toEqual([
      "Dots will be removed from email local-parts",
      "“+tag” sub-addresses will be kept",
    ]);
  });

  it("names the region when one is set and says so when it is cleared", () => {
    expect(transformChangeLines({ phone_default_region: "GB" })).toEqual([
      "National-format numbers will default to GB",
    ]);
    expect(transformChangeLines({ phone_default_region: "" })).toEqual([
      "National-format numbers will have no default region",
    ]);
  });
});
