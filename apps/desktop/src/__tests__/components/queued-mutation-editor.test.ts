// Tests for the QueuedMutationEditor pure helpers:
//
//   - deriveFlatFields: flat string/number/boolean objects become
//     per-field editor rows (key order preserved); everything else
//     (nested, arrays, nulls, empty/non-objects) falls back to the
//     raw-JSON textarea (null).
//   - buildBodyFromFields: rebuilds the body with the ORIGINAL types
//     preserved — a number edited as text parses back to a number, and
//     text that no longer parses is an honest per-field error, never a
//     silent string.
//   - parseRawBody: validated raw-JSON fallback; empty input means
//     "no body"; invalid JSON carries the parser's message.
//   - stringifyBody: textarea seeding.

import { describe, expect, it } from "vitest";

import {
  buildBodyFromFields,
  deriveFlatFields,
  parseRawBody,
  stringifyBody,
  type FlatField,
} from "../../components/queued-mutation-editor-helpers";

describe("deriveFlatFields", () => {
  it("derives typed fields from a flat object, preserving key order", () => {
    const fields = deriveFlatFields({
      name: "Spring promo",
      send_limit: 250,
      double_optin: true,
    });
    expect(fields).toEqual([
      { key: "name", type: "string", raw: "Spring promo" },
      { key: "send_limit", type: "number", raw: "250" },
      { key: "double_optin", type: "boolean", raw: true },
    ]);
  });

  it("keeps falsy-but-valid values editable", () => {
    expect(deriveFlatFields({ a: "", b: 0, c: false })).toEqual([
      { key: "a", type: "string", raw: "" },
      { key: "b", type: "number", raw: "0" },
      { key: "c", type: "boolean", raw: false },
    ]);
  });

  it("returns null for nested objects and arrays (raw-JSON fallback)", () => {
    expect(deriveFlatFields({ name: "x", meta: { a: 1 } })).toBeNull();
    expect(deriveFlatFields({ tags: ["a", "b"] })).toBeNull();
  });

  it("returns null for null values — type can't be preserved", () => {
    expect(deriveFlatFields({ name: "x", deleted_at: null })).toBeNull();
  });

  it("returns null for non-objects, arrays, and empty objects", () => {
    expect(deriveFlatFields(undefined)).toBeNull();
    expect(deriveFlatFields(null)).toBeNull();
    expect(deriveFlatFields("just a string")).toBeNull();
    expect(deriveFlatFields(42)).toBeNull();
    expect(deriveFlatFields([{ a: 1 }])).toBeNull();
    expect(deriveFlatFields({})).toBeNull();
  });
});

describe("buildBodyFromFields", () => {
  it("round-trips a flat body through derive → build with types intact", () => {
    const body = { name: "Spring promo", send_limit: 250, double_optin: true };
    const fields = deriveFlatFields(body);
    expect(fields).not.toBeNull();
    const rebuilt = buildBodyFromFields(fields as FlatField[]);
    expect(rebuilt).toEqual({ ok: true, body });
  });

  it("parses edited number text back to a number (type preservation)", () => {
    const result = buildBodyFromFields([
      { key: "send_limit", type: "number", raw: " 500 " },
    ]);
    expect(result).toEqual({ ok: true, body: { send_limit: 500 } });
  });

  it("rejects number fields that no longer parse, naming the field", () => {
    const result = buildBodyFromFields([
      { key: "send_limit", type: "number", raw: "lots" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"send_limit"');
      expect(result.error).toContain("number");
    }
  });

  it("rejects an emptied number field instead of coercing to 0", () => {
    const result = buildBodyFromFields([
      { key: "send_limit", type: "number", raw: "" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("keeps string fields verbatim — including numeric-looking text", () => {
    const result = buildBodyFromFields([
      { key: "name", type: "string", raw: "123" },
    ]);
    expect(result).toEqual({ ok: true, body: { name: "123" } });
  });

  it("emits booleans from checkbox state", () => {
    expect(
      buildBodyFromFields([{ key: "double_optin", type: "boolean", raw: false }]),
    ).toEqual({ ok: true, body: { double_optin: false } });
  });

  it("preserves key order in the rebuilt body", () => {
    const result = buildBodyFromFields([
      { key: "z", type: "string", raw: "1" },
      { key: "a", type: "string", raw: "2" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.body as Record<string, unknown>)).toEqual([
        "z",
        "a",
      ]);
    }
  });
});

describe("parseRawBody", () => {
  it("parses valid JSON (nested bodies included)", () => {
    expect(parseRawBody('{"a": {"b": [1, 2]}}')).toEqual({
      ok: true,
      body: { a: { b: [1, 2] } },
    });
  });

  it("treats empty / whitespace-only input as 'no body'", () => {
    expect(parseRawBody("")).toEqual({ ok: true, body: undefined });
    expect(parseRawBody("   \n  ")).toEqual({ ok: true, body: undefined });
  });

  it("surfaces an honest error for invalid JSON", () => {
    const result = parseRawBody("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Not valid JSON");
    }
  });
});

describe("stringifyBody", () => {
  it("pretty-prints a body for the textarea seed", () => {
    expect(stringifyBody({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("seeds an empty textarea for a missing body", () => {
    expect(stringifyBody(undefined)).toBe("");
  });

  it("round-trips through parseRawBody", () => {
    const body = { a: { b: ["x", 2, true] }, c: null };
    expect(parseRawBody(stringifyBody(body))).toEqual({ ok: true, body });
  });
});
