import { describe, expect, it } from "vitest";

import { GET } from "@/app/popup.js/route";

describe("embedded popup script", () => {
  it("uses credentialless, abortable public API calls", async () => {
    const res = GET();
    const js = await res.text();

    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(js).toContain("function fetchWithTimeout");
    expect(js).toContain("new AbortController()");
    expect(js.match(/credentials: "omit"/g)).toHaveLength(2);
    expect(js).toContain('options.redirect = "error"');
    expect(js).toContain("function safeExternalUrl");
    expect(js).toContain("function cleanToken");
    expect(js).toContain("function cleanDelay");
    expect(js).toContain("function isLocalHost");
    expect(js).toContain("url.protocol === \"https:\"");
    expect(js).toContain("window.location.protocol === \"http:\"");
    expect(js).toContain("if (url.username || url.password) return \"\"");
    expect(js).toContain("url.hash = \"\"");
    expect(js).toContain("value.length > 2048");
    expect(js).toContain("function utf8ByteLength");
    expect(js).toContain("/api/public/popups/");
    expect(js).toContain("/submit");
  });
});
