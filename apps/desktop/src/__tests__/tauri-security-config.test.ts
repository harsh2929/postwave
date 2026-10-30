import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface TauriConfig {
  app: { security: { csp: string; devCsp: string } };
}

function directive(policy: string, name: string): string[] {
  const found = policy
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([candidate]) => candidate === name);
  return found?.slice(1) ?? [];
}

describe("Tauri renderer security policy", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  ) as TauriConfig;

  it("denies dangerous document primitives", () => {
    expect(config.app.security.csp).toContain("base-uri 'none'");
    expect(config.app.security.csp).toContain("object-src 'none'");
    expect(config.app.security.csp).toContain("form-action 'none'");
    expect(config.app.security.csp).toContain("frame-ancestors 'none'");
  });

  it("does not grant production network or image access to arbitrary HTTPS origins", () => {
    expect(directive(config.app.security.csp, "connect-src")).not.toContain(
      "https:",
    );
    expect(directive(config.app.security.csp, "img-src")).not.toContain(
      "https:",
    );
    expect(directive(config.app.security.csp, "frame-src")).not.toContain(
      "https:",
    );
  });
});
