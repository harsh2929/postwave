import { describe, expect, it } from "vitest";

import { validateWebhookPlaygroundRawJSONObject } from "../../lib/api/webhook-playground-contract";

describe("webhook playground raw JSON contract", () => {
  it("returns the exact original text while validating a disposable object copy", () => {
    const rawJSON = ` {
  "large_integer": 9007199254740993,
  "message": "exact 🔒"
} `;

    const validated = validateWebhookPlaygroundRawJSONObject(rawJSON);

    expect(validated.rawJSON).toBe(rawJSON);
    expect(validated.rawJSON).toContain("9007199254740993");
    expect(validated.parsed).toMatchObject({ message: "exact 🔒" });
  });

  it.each([
    ["literal root duplicate", '{"a":1,"a":2}'],
    ["escape-equivalent root duplicate", String.raw`{"a":1,"\u0061":2}`],
    ["escaped-solidus root duplicate", String.raw`{"a/b":1,"a\/b":2}`],
    [
      "surrogate-escape-equivalent root duplicate",
      String.raw`{"😀":1,"\ud83d\ude00":2}`,
    ],
    [
      "unpaired-surrogate replacement-equivalent root duplicate",
      String.raw`{"\ud800":1,"\ufffd":2}`,
    ],
    [
      "unpaired-low-surrogate replacement-equivalent root duplicate",
      String.raw`{"\udc00":1,"�":2}`,
    ],
    ["nested object duplicate", '{"outer":{"x":1,"x":2}}'],
    [
      "object-in-array duplicate",
      String.raw`{"items":[{"name":1,"\u006eame":2}]}`,
    ],
  ])("rejects a %s", (_label, rawJSON) => {
    expect(() => validateWebhookPlaygroundRawJSONObject(rawJSON)).toThrow(
      /duplicate object member names/u,
    );
  });

  it("allows the same member name in distinct object scopes", () => {
    const rawJSON = '{"left":{"id":1},"right":{"id":2}}';

    expect(validateWebhookPlaygroundRawJSONObject(rawJSON)).toEqual({
      rawJSON,
      parsed: { left: { id: 1 }, right: { id: 2 } },
    });
  });

  it("accepts the complete bounded JSON scalar grammar inside an object", () => {
    const rawJSON = String.raw`{"values":[null,true,false,-0,12.5e+2,"quote: \" slash: \/ tab: \t unicode: \u0061"]}`;

    expect(validateWebhookPlaygroundRawJSONObject(rawJSON).rawJSON).toBe(
      rawJSON,
    );
  });

  it("accepts an exponent beyond JavaScript's finite-number range without normalizing it", () => {
    const rawJSON = '{"value":1e9999}';

    const validated = validateWebhookPlaygroundRawJSONObject(rawJSON);

    expect(validated.rawJSON).toBe(rawJSON);
    expect(validated.parsed.value).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    ["empty input", ""],
    ["array root", "[]"],
    ["null root", "null"],
    ["malformed object", '{"missing":'],
    ["trailing content", '{"value":1} trailing'],
    ["ill-formed raw Unicode", `{"value":"${"\ud800"}"}`],
    ["non-string input", 42],
  ])("rejects %s", (_label, rawJSON) => {
    expect(() => validateWebhookPlaygroundRawJSONObject(rawJSON)).toThrow();
  });

  it("enforces the raw UTF-8 byte ceiling without trimming retained text", () => {
    const exact = `${" ".repeat(262_142)}{}`;
    const oversized = `${" ".repeat(262_143)}{}`;

    expect(validateWebhookPlaygroundRawJSONObject(exact).rawJSON).toBe(exact);
    expect(() => validateWebhookPlaygroundRawJSONObject(oversized)).toThrow(
      /262144 UTF-8 bytes/u,
    );
  });

  it("enforces depth, node, field, key, and string bounds on raw structure", () => {
    let deep: Record<string, unknown> = { end: true };
    for (let index = 0; index < 25; index += 1) deep = { child: deep };
    const tooManyNodes = `{"items":[${Array.from(
      { length: 19_999 },
      () => "0",
    ).join(",")}]} `;
    const tooManyFields = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 2_001 }, (_, index) => [`field_${index}`, index]),
      ),
    );
    const oversizedKey = JSON.stringify({ ["k".repeat(257)]: true });
    const oversizedString = JSON.stringify({ value: "v".repeat(131_073) });

    for (const rawJSON of [
      JSON.stringify(deep),
      tooManyNodes,
      tooManyFields,
      oversizedKey,
      oversizedString,
    ]) {
      expect(() => validateWebhookPlaygroundRawJSONObject(rawJSON)).toThrow();
    }
  });
});
