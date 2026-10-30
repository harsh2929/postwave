// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { normalizeBrowserAuthBaseUrl } from "../../src/auth/login.js";

describe("normalizeBrowserAuthBaseUrl", () => {
  it("normalizes safe browser login bases", () => {
    expect(normalizeBrowserAuthBaseUrl("https://api.moosewave.com/api")).toBe(
      "https://api.moosewave.com",
    );
    expect(normalizeBrowserAuthBaseUrl("http://localhost:8080/api")).toBe(
      "http://localhost:8080",
    );
  });

  it("rejects unsafe browser login bases", () => {
    expect(normalizeBrowserAuthBaseUrl("https://u:p@api.moosewave.com")).toBeNull();
    expect(normalizeBrowserAuthBaseUrl("https://api.moosewave.com?x=1")).toBeNull();
    expect(normalizeBrowserAuthBaseUrl("http://api.moosewave.com")).toBeNull();
    expect(normalizeBrowserAuthBaseUrl("https://api.moosewave.com\nbad")).toBeNull();
  });
});
