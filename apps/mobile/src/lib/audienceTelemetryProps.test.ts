import { describe, expect, it } from "vitest";

import {
  audienceFilterProps,
  audienceSearchProps,
  audienceStatusProps,
  audienceSuppressProps,
  audienceTagProps,
} from "./audienceTelemetryProps";

describe("audienceSearchProps", () => {
  it("emits a LENGTH, never the query text", () => {
    const props = audienceSearchProps("ada@example.com", 3);
    expect(props).toEqual({ query_length: 15, result_count: 3 });
    expect(JSON.stringify(props)).not.toContain("ada");
  });

  it("trims before measuring", () => {
    expect(audienceSearchProps("  ab  ", 0).query_length).toBe(2);
  });

  it("caps a pathological paste so the length is not a fingerprint", () => {
    expect(audienceSearchProps("x".repeat(5000), 0).query_length).toBe(512);
  });

  it("distinguishes 'no count yet' from 'zero results'", () => {
    expect(audienceSearchProps("ab", undefined).result_count).toBe(-1);
    expect(audienceSearchProps("ab", 0).result_count).toBe(0);
    expect(audienceSearchProps("ab", Number.NaN).result_count).toBe(-1);
  });
});

describe("audienceFilterProps", () => {
  it("passes contract keys through", () => {
    expect(audienceFilterProps("unsubscribed", "chip")).toEqual({
      key: "unsubscribed",
      source: "chip",
    });
  });

  it("collapses an unknown key to 'other' rather than passing it through", () => {
    expect(audienceFilterProps("someone@example.com", "segment").key).toBe(
      "other",
    );
  });

  it("is case- and whitespace-insensitive", () => {
    expect(audienceFilterProps(" Subscribed ", "chip").key).toBe("subscribed");
  });
});

describe("audienceTagProps", () => {
  it("emits the outcome and source enums only — never the tag name", () => {
    expect(audienceTagProps("added", "suggestion")).toEqual({
      outcome: "added",
      source: "suggestion",
    });
  });
});

describe("audienceStatusProps", () => {
  it("passes engine statuses through", () => {
    expect(audienceStatusProps("blocklisted")).toEqual({ kind: "blocklisted" });
  });

  it("collapses an unreviewed status to 'other'", () => {
    expect(audienceStatusProps("some_future_state")).toEqual({ kind: "other" });
  });
});

describe("audienceSuppressProps", () => {
  it("carries where it happened and what happened", () => {
    expect(audienceSuppressProps("row", "undone")).toEqual({
      source: "row",
      outcome: "undone",
    });
  });
});
