import { describe, expect, it } from "vitest";

import { apiUrl, normalizeApiBaseUrl } from "./url";

describe("mobile API URL helpers", () => {
  it("normalizes safe API bases and preserves self-hosted base paths", () => {
    expect(normalizeApiBaseUrl("https://api.example.com///")).toBe(
      "https://api.example.com",
    );
    expect(apiUrl("https://api.example.com/gateway///", "api/v1/me")).toBe(
      "https://api.example.com/gateway/api/v1/me",
    );
  });

  it("rejects absolute-looking request paths", () => {
    expect(() =>
      apiUrl("https://api.example.com/gateway", "https://evil.example/x"),
    ).toThrow(/Unsafe API path/);
    expect(() => apiUrl("https://api.example.com/gateway", "//evil.example/x")).toThrow(
      /Unsafe API path/,
    );
  });

  it("rejects unsafe bases and path traversal", () => {
    expect(() => normalizeApiBaseUrl("https://u:p@api.example.com")).toThrow(
      /valid http\(s\) URL/,
    );
    expect(() => normalizeApiBaseUrl("file:///tmp/postwave")).toThrow(
      /valid http\(s\) URL/,
    );
    expect(() => apiUrl("https://api.example.com/gateway", "../api/v1/me")).toThrow(
      /Unsafe API path/,
    );
    expect(() =>
      apiUrl("https://api.example.com/gateway", "/api/v1/%2e%2e/admin"),
    ).toThrow(/Unsafe API path/);
  });
});
