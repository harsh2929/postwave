// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { formatOutput } from "../../src/lib/output.js";

describe("formatOutput", () => {
  it("renders json by default", () => {
    const out = formatOutput({ a: 1 }, "json");
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it("renders an array as a table", () => {
    const rows = [
      { id: "1", name: "alpha" },
      { id: "2", name: "beta" },
    ];
    const out = formatOutput(rows, "table");
    expect(out).toContain("id");
    expect(out).toContain("name");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  it("renders yaml for nested objects", () => {
    const out = formatOutput({ outer: { inner: "v" } }, "yaml");
    expect(out).toContain("outer:");
    expect(out).toContain("inner: v");
  });

  it("renders empty arrays cleanly", () => {
    expect(formatOutput([], "table")).toBe("(no rows)");
    expect(formatOutput([], "json")).toBe("[]");
  });
});
