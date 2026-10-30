import { describe, expect, it } from "vitest";

import { parseTemplatePreviewVars } from "@/lib/template-preview-vars";

describe("parseTemplatePreviewVars", () => {
  it("coerces primitive JSON object values to strings", () => {
    expect(
      parseTemplatePreviewVars(
        JSON.stringify({ name: "Alex", count: 3, empty: null }),
      ),
    ).toEqual({
      vars: { name: "Alex", count: "3", empty: "" },
      error: null,
    });
  });

  it("rejects arrays and oversized UTF-8 payloads", () => {
    expect(parseTemplatePreviewVars("[]").error).toMatch(/object/i);
    expect(
      parseTemplatePreviewVars(JSON.stringify({ pad: "😊".repeat(18_000) }))
        .error,
    ).toMatch(/too large/i);
  });

  it("rejects pathological key and value counts", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(parseTemplatePreviewVars(JSON.stringify(tooMany)).error).toMatch(
      /at most 100/i,
    );
    expect(
      parseTemplatePreviewVars(JSON.stringify({ ok: "x".repeat(4097) }))
        .error,
    ).toMatch(/too long/i);
    expect(
      parseTemplatePreviewVars(JSON.stringify({ " first_name": "Alex" })).error,
    ).toMatch(/variable names/i);
    expect(
      parseTemplatePreviewVars(JSON.stringify({ "first\nname": "Alex" })).error,
    ).toMatch(/variable names/i);
  });
});
