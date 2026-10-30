import { describe, expect, it } from "vitest";

import { publicOrigin } from "@/lib/site-url";

describe("site-url", () => {
  it("normalizes public origins", () => {
    expect(publicOrigin(" https://moosewave.com/// ", "https://fallback.test")).toBe(
      "https://moosewave.com",
    );
  });

  it("falls back for unsafe or malformed public origins", () => {
    const fallback = "https://fallback.test";
    expect(publicOrigin("https://user:pass@moosewave.com", fallback)).toBe(fallback);
    expect(publicOrigin("https://moosewave.com?x=1", fallback)).toBe(fallback);
    expect(publicOrigin("https://moosewave.com#secret", fallback)).toBe(fallback);
    expect(publicOrigin("http://moosewave.com", fallback)).toBe(fallback);
    expect(publicOrigin("https://moosewave.com/\nmalformed", fallback)).toBe(fallback);
    expect(publicOrigin("javascript:alert(1)", fallback)).toBe(fallback);
    expect(publicOrigin("not a url", fallback)).toBe(fallback);
  });

  it("allows localhost HTTP origins for local development", () => {
    expect(publicOrigin("http://localhost:3000///", "https://fallback.test")).toBe(
      "http://localhost:3000",
    );
  });
});
