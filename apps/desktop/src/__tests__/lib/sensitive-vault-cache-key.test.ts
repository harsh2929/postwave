// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { sensitiveVaultCacheKey } from "../../lib/sensitive-vault-cache-key";

beforeEach(() => localStorage.clear());

describe("sensitiveVaultCacheKey", () => {
  it("removes the readable legacy key without adopting its ciphertext", async () => {
    const legacy =
      "postwave.desktop.vault.v1:sensitive:user:person_example.com:_api_v1_subscribers_person_example.com";
    localStorage.setItem(legacy, "legacy-envelope");

    const key = await sensitiveVaultCacheKey(
      "user:person@example.com",
      "/api/v1/subscribers/person@example.com",
    );

    expect(key).toMatch(/^sensitive-cache:sha256:[a-f0-9]{64}$/u);
    expect(key).not.toContain("person@example.com");
    expect(key).not.toContain("subscribers");
    expect(localStorage.getItem(legacy)).toBeNull();
  });

  it("fails closed without a resolved identity", async () => {
    await expect(
      sensitiveVaultCacheKey(null, "/api/v1/subscribers/person@example.com"),
    ).resolves.toBeNull();
  });
});
