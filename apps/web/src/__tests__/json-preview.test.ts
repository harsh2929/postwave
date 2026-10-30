import { describe, expect, it } from "vitest";

import {
  boundPreview,
  payloadPreview,
  prettyJson,
  prettyJsonValue,
} from "@/lib/json-preview";

describe("prettyJson", () => {
  it("pretty-prints valid JSON with 2-space indent", () => {
    expect(prettyJson('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it("returns the raw string unchanged for non-JSON input", () => {
    expect(prettyJson("not json <script>")).toBe("not json <script>");
  });

  it("returns empty string for blank input", () => {
    expect(prettyJson("   ")).toBe("");
  });
});

describe("prettyJsonValue", () => {
  it("stringifies a decoded value", () => {
    expect(prettyJsonValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it("passes strings through", () => {
    expect(prettyJsonValue("hello")).toBe("hello");
  });
});

describe("boundPreview", () => {
  it("leaves short strings untouched", () => {
    expect(boundPreview("short", 100)).toBe("short");
  });
  it("elides long strings with a count", () => {
    const out = boundPreview("x".repeat(50), 10);
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("40 more characters");
  });
});

describe("payloadPreview", () => {
  it("pretty-prints then bounds", () => {
    const out = payloadPreview('{"a":1}', 1000);
    expect(out).toBe('{\n  "a": 1\n}');
  });
});
