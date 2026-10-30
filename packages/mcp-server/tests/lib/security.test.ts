// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";

import { validateUrl, capResponse, SsrfError, __TRUNCATION_MARKER } from "../../src/lib/security.js";

describe("validateUrl (SSRF guard)", () => {
  it("accepts a normal https URL", () => {
    expect(() => validateUrl("https://example.invalid/feed.xml")).not.toThrow();
  });

  it("rejects non-http schemes", () => {
    expect(() => validateUrl("file:///etc/passwd")).toThrow(SsrfError);
    expect(() => validateUrl("gopher://example.invalid/")).toThrow(SsrfError);
  });

  it("rejects localhost by name", () => {
    expect(() => validateUrl("http://localhost/")).toThrow(SsrfError);
    expect(() => validateUrl("http://example.localhost/")).toThrow(SsrfError);
  });

  it("rejects URL credentials", () => {
    expect(() => validateUrl("https://user:pass@example.invalid/")).toThrow(SsrfError);
  });

  it("rejects IPv4 loopback 127.0.0.0/8", () => {
    expect(() => validateUrl("http://127.0.0.1/")).toThrow(SsrfError);
    expect(() => validateUrl("http://127.99.99.99/")).toThrow(SsrfError);
    expect(() => validateUrl("http://2130706433/")).toThrow(SsrfError);
    expect(() => validateUrl("http://0x7f000001/")).toThrow(SsrfError);
  });

  it("rejects RFC1918 private ranges", () => {
    expect(() => validateUrl("http://10.0.0.1/")).toThrow(SsrfError);
    expect(() => validateUrl("http://192.168.1.1/")).toThrow(SsrfError);
    expect(() => validateUrl("http://172.16.0.1/")).toThrow(SsrfError);
    expect(() => validateUrl("http://172.31.255.255/")).toThrow(SsrfError);
  });

  it("rejects link-local + AWS/GCP metadata 169.254.0.0/16", () => {
    expect(() => validateUrl("http://169.254.169.254/latest/meta-data/")).toThrow(SsrfError);
    expect(() => validateUrl("http://metadata.google.internal/")).toThrow(SsrfError);
  });

  it("rejects IPv6 loopback and ULA", () => {
    expect(() => validateUrl("http://[::1]/")).toThrow(SsrfError);
    expect(() => validateUrl("http://[fc00::1]/")).toThrow(SsrfError);
    expect(() => validateUrl("http://[fe80::1]/")).toThrow(SsrfError);
  });

  it("rejects malformed URLs", () => {
    expect(() => validateUrl("not a url at all")).toThrow(SsrfError);
    expect(() => validateUrl(" https://example.invalid/feed.xml")).toThrow(SsrfError);
    expect(() => validateUrl("https://example.invalid/feed.xml\nHeader: x")).toThrow(SsrfError);
  });
});

describe("capResponse", () => {
  it("returns the value unchanged when under the cap", () => {
    const r = capResponse({ a: 1, b: "two" }, 1024);
    expect(r.truncated).toBe(false);
    expect(r.data).toEqual({ a: 1, b: "two" });
  });

  it("truncates oversize payloads and emits the marker", () => {
    const big = { blob: "x".repeat(1024) };
    const r = capResponse(big, 256);
    expect(r.truncated).toBe(true);
    expect(typeof r.data).toBe("string");
    expect(r.data as string).toContain(__TRUNCATION_MARKER);
    expect(r.byteLength).toBeGreaterThan(256);
  });

  it("reports the original byte length even when truncated", () => {
    const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: `id_${i}` })) };
    const r = capResponse(big, 100);
    expect(r.truncated).toBe(true);
    expect(r.byteLength).toBeGreaterThan(100);
  });

  it("truncates by UTF-8 bytes for multibyte payloads", () => {
    const r = capResponse({ text: "é".repeat(200) }, 100);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(String(r.data).split("\n")[0] ?? "", "utf8")).toBeLessThanOrEqual(
      100,
    );
    expect(String(r.data)).toContain(__TRUNCATION_MARKER);
  });
});
