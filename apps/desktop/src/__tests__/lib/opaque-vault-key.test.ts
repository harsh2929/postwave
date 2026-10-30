import { describe, expect, it } from "vitest";

import { opaqueVaultKey } from "../../lib/opaque-vault-key";

describe("opaqueVaultKey", () => {
  it("is deterministic without exposing identity, email, or request path", async () => {
    const logical = JSON.stringify([
      "user:person@example.com:tenant:client-a",
      "/api/v1/subscribers/person@example.com",
    ]);
    const first = await opaqueVaultKey("sensitive-cache", logical);
    const second = await opaqueVaultKey("sensitive-cache", logical);

    expect(first).toBe(second);
    expect(first).toMatch(/^sensitive-cache:sha256:[a-f0-9]{64}$/u);
    expect(first).not.toContain("person@example.com");
    expect(first).not.toContain("subscribers");
    expect(first).not.toContain("client-a");
  });

  it("does not collapse logical locators that legacy key sanitizing merged", async () => {
    const slash = await opaqueVaultKey(
      "sensitive-cache",
      JSON.stringify(["identity", "/api/v1/subscribers/a/b"]),
    );
    const underscore = await opaqueVaultKey(
      "sensitive-cache",
      JSON.stringify(["identity", "/api/v1/subscribers/a_b"]),
    );

    expect(slash).not.toBe(underscore);
  });

  it("fails closed for invalid namespaces, control text, and oversized keys", async () => {
    await expect(
      opaqueVaultKey("Sensitive Cache", "value"),
    ).resolves.toBeNull();
    await expect(
      opaqueVaultKey("sensitive-cache", "value\nother"),
    ).resolves.toBeNull();
    await expect(
      opaqueVaultKey("sensitive-cache", "x".repeat(33 * 1024)),
    ).resolves.toBeNull();
  });
});
