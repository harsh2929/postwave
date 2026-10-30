import { describe, expect, it } from "vitest";

import { parseCollectionUpload } from "../../lib/collections/collection-import";
import {
  collectionNameFromFile,
  validateCollectionName,
  validateCollectionQuery,
} from "../../lib/collections/collection-validation";

describe("reference collection import contract", () => {
  it("parses quoted CSV without changing row values", () => {
    const parsed = parseCollectionUpload(
      "references.csv",
      'code,message\r\nA-1,"Hello, world"\r\nA-2,"line one\nline two"',
    );

    expect(parsed.columns).toEqual(["code", "message"]);
    expect(parsed.rows).toEqual([
      { code: "A-1", message: "Hello, world" },
      { code: "A-2", message: "line one\nline two" },
    ]);
    expect(parsed.sourceType).toBe("uploaded");
  });

  it("rejects short and long ragged CSV rows", () => {
    expect(() => parseCollectionUpload("short.csv", "a,b\n1")).toThrow(
      /every row must match/u,
    );
    expect(() => parseCollectionUpload("long.csv", "a,b\n1,2,3")).toThrow(
      /every row must match/u,
    );
  });

  it("preserves one-column empty rows and rejects ambiguous wider blank rows", () => {
    expect(parseCollectionUpload("empty.csv", "value\n\n").rows).toEqual([
      { value: "" },
    ]);
    expect(() => parseCollectionUpload("blank.csv", "a,b\n1,2\n\n"))
      .toThrow(/Row 3 has 1 cells/u);
  });

  it("rejects unterminated and misplaced CSV quotes", () => {
    expect(() => parseCollectionUpload("open.csv", 'a,b\n1,"open')).toThrow(
      /unterminated/u,
    );
    expect(() => parseCollectionUpload("mid.csv", 'a,b\nva"lue,2')).toThrow(
      /must start with a quote/u,
    );
  });

  it("rejects ambiguous, reserved, and direction-spoofing field names", () => {
    expect(() => parseCollectionUpload("space.csv", " code,value\na,b")).toThrow(
      /leading or trailing whitespace/u,
    );
    expect(() => parseCollectionUpload("duplicate.csv", "Code,code\na,b")).toThrow(
      /unique/u,
    );
    expect(() =>
      parseCollectionUpload("reserved.json", '[{"__proto__":"x"}]'),
    ).toThrow(/not a supported column/u);
    expect(() =>
      parseCollectionUpload("bidi.json", '[{"co\\u202ede":"x"}]'),
    ).toThrow(/text-direction/u);
    expect(() =>
      parseCollectionUpload("separator.csv", "co\u2028de,value\na,b"),
    ).toThrow(/text-direction/u);
  });

  it("detects duplicate JSON keys before JSON.parse can collapse them", () => {
    expect(() =>
      parseCollectionUpload("duplicate.json", '[{"sku":"one","sku":"two"}]'),
    ).toThrow(/duplicate object key “sku”/u);
    expect(() =>
      parseCollectionUpload(
        "escaped.json",
        '[{"sku":"one","\\u0073ku":"two"}]',
      ),
    ).toThrow(/duplicate object key “sku”/u);
    expect(() =>
      parseCollectionUpload(
        "nested.json",
        '[{"value":{"key":1,"key":2}}]',
      ),
    ).toThrow(/duplicate object key “key”/u);
  });

  it("rejects pathological nesting before parsing and non-flat row values", () => {
    const deeplyNested = `${"[".repeat(17)}0${"]".repeat(17)}`;
    expect(() => parseCollectionUpload("deep.json", deeplyNested)).toThrow(
      /nesting is too deep/u,
    );
    expect(() =>
      parseCollectionUpload("nested.json", '[{"value":{"nested":true}}]'),
    ).toThrow(/must be a string, safe number, boolean, or null/u);
  });

  it("rejects integers JSON.parse cannot preserve and guides quoting IDs", () => {
    expect(() =>
      parseCollectionUpload("ids.json", '[{"id":9007199254740993}]'),
    ).toThrow(/Quote long numeric identifiers/u);
    expect(
      parseCollectionUpload("ids.json", '[{"id":"9007199254740993"}]')
        .rows[0]?.id,
    ).toBe("9007199254740993");
  });

  it("rejects decimal spellings JSON.parse cannot round-trip exactly", () => {
    expect(() =>
      parseCollectionUpload(
        "decimal.json",
        '[{"rate":0.12345678901234567890}]',
      ),
    ).toThrow(/cannot round-trip exactly/u);
    expect(() => parseCollectionUpload("negative-zero.json", '[{"rate":-0}]'))
      .toThrow(/cannot round-trip exactly/u);
    expect(
      parseCollectionUpload("canonical.json", '[{"rate":0.125}]').rows[0]
        ?.rate,
    ).toBe(0.125);
  });

  it("accounts for PostgreSQL exponent expansion before the save", () => {
    const small = parseCollectionUpload("exponent.json", '[{"value":1e-20}]');
    expect(small.encodedBytes).toBe(
      new TextEncoder().encode('[{"value":0.00000000000000000001}]')
        .byteLength,
    );
    expect(() =>
      parseCollectionUpload(
        "expanded.json",
        JSON.stringify(
          Array.from({ length: 10_000 }, () => ({ value: 1e-100 })),
        ),
      ),
    ).toThrow(/1 MiB save limit/u);
  });

  it("rejects malformed Unicode before it reaches the API", () => {
    expect(() =>
      parseCollectionUpload("surrogate.json", '[{"message":"\\ud800"}]'),
    ).toThrow(/invalid Unicode/u);
  });

  it("keeps legitimate direction/control content values for isolated rendering", () => {
    const parsed = parseCollectionUpload(
      "localized.json",
      '[{"message":"مرحبا\\u202e","lines":"one\\ntwo"}]',
    );
    expect(parsed.rows[0]?.message).toBe("مرحبا\u202e");
    expect(parsed.rows[0]?.lines).toBe("one\ntwo");
  });

  it("rejects NUL cell values that PostgreSQL jsonb cannot persist", () => {
    expect(() => parseCollectionUpload("nul.csv", "value\none\u0000two"))
      .toThrow(/NUL character/u);
    expect(() =>
      parseCollectionUpload("nul.json", '[{"value":"one\\u0000two"}]'),
    ).toThrow(/NUL character/u);
  });

  it("preflights Go U+2028 escaping without falsely expanding HTML characters", () => {
    expect(
      parseCollectionUpload(
        "html.json",
        JSON.stringify([{ value: "&".repeat(44_000) }]),
      ).rows,
    ).toHaveLength(1);
    expect(() =>
      parseCollectionUpload(
        "row.json",
        JSON.stringify([
          {
            one: "\u2028".repeat(20_000),
            two: "\u2028".repeat(20_000),
            three: "\u2028".repeat(20_000),
          },
        ]),
      ),
    ).toThrow(/256 KiB encoded-row limit/u);

    const rows = Array.from({ length: 5 }, (_, index) => ({
      key: index,
      first: "\u2028".repeat(20_000),
      second: "\u2028".repeat(20_000),
    }));
    expect(() =>
      parseCollectionUpload("total.json", JSON.stringify(rows)),
    ).toThrow(/1 MiB save limit/u);
  });
});

describe("reference collection operator-text validation", () => {
  it("counts Unicode code points without splitting a filename emoji", () => {
    const derived = collectionNameFromFile(`${"😀".repeat(205)}.json`);
    expect(Array.from(derived)).toHaveLength(200);
    expect(derived.endsWith("😀")).toBe(true);
    expect(validateCollectionName(derived)).toBeNull();
  });

  it("rejects whitespace, controls, bidi formatting, and overlong search text", () => {
    expect(validateCollectionName(" name ")).toMatch(/leading or trailing/u);
    expect(validateCollectionName("name\u200f")).toMatch(/bidirectional/u);
    expect(validateCollectionName("name\u2029suffix")).toMatch(/bidirectional/u);
    expect(validateCollectionQuery("ok\u0000bad")).toMatch(/control/u);
    expect(validateCollectionQuery("a".repeat(201))).toMatch(/200/u);
  });
});
