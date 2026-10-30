// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config storage", () => {
  let tmp: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "postwave-cli-"));
    originalEnv = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips credentials", async () => {
    const { setCredentials, getCredentials, clearCredentials, isSafeCredentialValue } = await import(
      "../../src/lib/config.js"
    );
    setCredentials({
      apiKey: "pw_test_key",
      baseUrl: "https://api.example.test",
      tenantId: "tenant_abc",
      storedAt: "2026-04-30T00:00:00Z",
    });
    const got = getCredentials();
    expect(got?.apiKey).toBe("pw_test_key");
    expect(got?.baseUrl).toBe("https://api.example.test");
    clearCredentials();
    expect(getCredentials()).toBeUndefined();
    expect(isSafeCredentialValue("pw_test_key")).toBe(true);
    expect(isSafeCredentialValue("pw_test_key\nX-Bad: yes")).toBe(false);
  });

  it("rejects unsafe stored credentials", async () => {
    const { setCredentials, getCredentials } = await import("../../src/lib/config.js");

    expect(() =>
      setCredentials({
        apiKey: "pw_test_key\nX-Bad: yes",
        storedAt: "2026-04-30T00:00:00Z",
      }),
    ).toThrow(/unsafe API key/);
    expect(getCredentials()).toBeUndefined();
  });
});
