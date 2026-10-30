// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure parse/serialize contract for URL-persisted table state.

import { describe, expect, it } from "vitest";

import {
  enumParam,
  intParam,
  parseParams,
  serializeParams,
  serializeParamsString,
  stringParam,
} from "@/lib/table-url-state";

const schema = {
  page: intParam(1),
  q: stringParam(""),
  status: enumParam(["all", "enabled", "suppressed"] as const, "all"),
} as const;

function getter(record: Record<string, string>) {
  return (key: string) => (key in record ? record[key] : null);
}

describe("table-url-state parse", () => {
  it("falls back to defaults when params are absent", () => {
    expect(parseParams(schema, getter({}))).toEqual({
      page: 1,
      q: "",
      status: "all",
    });
  });

  it("decodes a full URL state", () => {
    expect(
      parseParams(schema, getter({ page: "3", q: "foo", status: "suppressed" })),
    ).toEqual({ page: 3, q: "foo", status: "suppressed" });
  });

  it("clamps a below-min page and rejects non-numeric pages", () => {
    expect(parseParams(schema, getter({ page: "0" })).page).toBe(1);
    expect(parseParams(schema, getter({ page: "-4" })).page).toBe(1);
    expect(parseParams(schema, getter({ page: "abc" })).page).toBe(1);
    expect(parseParams(schema, getter({ page: "2.9" })).page).toBe(2);
  });

  it("rejects an out-of-set enum value and uses the default", () => {
    expect(parseParams(schema, getter({ status: "bogus" })).status).toBe("all");
  });

  it("treats an empty-string param as absent", () => {
    expect(parseParams(schema, getter({ q: "" })).q).toBe("");
  });
});

describe("table-url-state serialize", () => {
  it("omits fields equal to their default", () => {
    expect(serializeParamsString(schema, {})).toBe("");
    expect(serializeParamsString(schema, { page: 1, q: "", status: "all" })).toBe(
      "",
    );
  });

  it("emits only non-default fields", () => {
    expect(serializeParamsString(schema, { page: 3, q: "foo" })).toBe(
      "page=3&q=foo",
    );
    expect(serializeParamsString(schema, { status: "suppressed" })).toBe(
      "status=suppressed",
    );
  });

  it("trims whitespace-only search into omission", () => {
    expect(serializeParamsString(schema, { q: "   " })).toBe("");
    expect(serializeParamsString(schema, { q: "  hi  " })).toBe("q=hi");
  });

  it("round-trips a state through serialize -> parse", () => {
    const state = { page: 5, q: "vip", status: "enabled" as const };
    const params = serializeParams(schema, state);
    expect(parseParams(schema, (k) => params.get(k))).toEqual(state);
  });
});
