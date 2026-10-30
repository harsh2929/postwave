// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Guards the machine-discoverable vulnerability-disclosure file (MKTN-021).
// RFC 9116 requires at least a Contact and an Expires field, and Expires must
// be in the future or scanners treat the file as stale.
describe("/.well-known/security.txt", () => {
  const file = path.resolve("public/.well-known/security.txt");

  it("is served from public/.well-known", () => {
    expect(existsSync(file)).toBe(true);
  });

  it("has valid Contact and a future Expires", () => {
    const text = readFileSync(file, "utf8");
    const contact = text.match(/^Contact:\s*(.+)$/m)?.[1]?.trim();
    const expires = text.match(/^Expires:\s*(.+)$/m)?.[1]?.trim();
    expect(contact).toBeTruthy();
    expect(contact).toContain("security@moosewave.com");
    expect(expires).toBeTruthy();
    expect(Number.isNaN(Date.parse(expires ?? ""))).toBe(false);
    expect(new Date(expires ?? "").getTime()).toBeGreaterThan(Date.now());
  });
});
