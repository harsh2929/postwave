import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "./csp";

describe("ops content security policy", () => {
  it("binds scripts to one nonce without an inline-script escape hatch", () => {
    const policy = contentSecurityPolicy("YWJjZGVmZ2hpamtsbW5vcA==");
    expect(policy).toContain("script-src 'self' 'nonce-YWJjZGVmZ2hpamtsbW5vcA==' 'strict-dynamic'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(() => contentSecurityPolicy("bad nonce\nvalue")).toThrow("invalid CSP nonce");
  });

  it("permits eval only in the explicit development policy", () => {
    expect(contentSecurityPolicy("YWJjZGVmZ2hpamtsbW5vcA==", true)).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy("YWJjZGVmZ2hpamtsbW5vcA==", false)).not.toContain("'unsafe-eval'");
  });
});
