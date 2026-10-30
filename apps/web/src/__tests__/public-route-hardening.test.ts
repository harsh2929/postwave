import { describe, expect, it } from "vitest";

import { GET as redirectPopup } from "@/app/embed/popup.js/route";
import { sanitizeOgText } from "@/lib/og-text";

describe("public route hardening", () => {
  it("limits and normalizes OG text inputs before rendering", () => {
    expect(sanitizeOgText("  Launch\n\tupdate  ", 40)).toBe("Launch update");
    expect(sanitizeOgText("x".repeat(80), 20)).toBe("x".repeat(20));
    expect(sanitizeOgText("\u0000\u0007", 20)).toBe("");
  });

  it("whitelists legacy popup embed redirect params", () => {
    const res = redirectPopup(
      new Request(
        "https://forms.postwave.test/embed/popup.js?key=pk_1&tenant=demo&evil=1&trigger=exit&delay=500",
      ),
    );
    const location = res.headers.get("location") ?? "";

    expect(res.status).toBe(308);
    expect(location).toBe(
      "https://forms.postwave.test/popup.js?key=pk_1&tenant=demo&trigger=exit&delay=500",
    );
    expect(location).not.toContain("evil");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("drops unsafe popup redirect params", () => {
    const res = redirectPopup(
      new Request(
        `https://forms.postwave.test/embed/popup.js?key=${"x".repeat(300)}&tenant=demo%0Aevil`,
      ),
    );

    expect(res.headers.get("location")).toBe(
      "https://forms.postwave.test/popup.js",
    );
  });
});
