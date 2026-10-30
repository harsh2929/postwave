import { describe, expect, it } from "vitest";

import {
  apiKeyState,
  isHighRiskKey,
  sortApiKeys,
  type ApiKeyLike,
} from "./apiKeyRows";

const NOW = Date.parse("2026-07-25T12:00:00Z");

function key(over: Partial<ApiKeyLike> & { id: string }): ApiKeyLike {
  return {
    scopes: ["read:reports"],
    createdAt: "2026-01-01T00:00:00Z",
    sandboxOnly: false,
    ...over,
  };
}

describe("sortApiKeys", () => {
  it("puts live keys before revoked ones", () => {
    const rows = sortApiKeys([
      key({ id: "revoked", revokedAt: "2026-07-01T00:00:00Z" }),
      key({ id: "live" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["live", "revoked"]);
  });

  it("orders live keys by most recently used", () => {
    const rows = sortApiKeys([
      key({ id: "old", lastUsedAt: "2026-06-01T00:00:00Z" }),
      key({ id: "hot", lastUsedAt: "2026-07-24T00:00:00Z" }),
      key({ id: "never" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["hot", "old", "never"]);
  });

  it("falls back to newest when neither key has been used", () => {
    const rows = sortApiKeys([
      key({ id: "older", createdAt: "2025-01-01T00:00:00Z" }),
      key({ id: "newer", createdAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["newer", "older"]);
  });

  it("is total — identical rows fall back to id so the order is stable", () => {
    const rows = sortApiKeys([key({ id: "b" }), key({ id: "a" })]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("tolerates unparseable timestamps instead of producing NaN order", () => {
    const rows = sortApiKeys([
      key({ id: "bad", lastUsedAt: "not a date" }),
      key({ id: "good", lastUsedAt: "2026-07-01T00:00:00Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["good", "bad"]);
  });

  it("does not mutate its input", () => {
    const input = [key({ id: "b" }), key({ id: "a" })];
    sortApiKeys(input);
    expect(input.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("apiKeyState", () => {
  it("reports revoked ahead of everything else", () => {
    expect(
      apiKeyState(
        key({
          id: "x",
          revokedAt: "2026-01-01T00:00:00Z",
          expiresAt: "2025-01-01T00:00:00Z",
          sandboxOnly: true,
        }),
        NOW,
      ),
    ).toBe("revoked");
  });

  it("reports expired for a past expiry", () => {
    expect(
      apiKeyState(key({ id: "x", expiresAt: "2026-07-01T00:00:00Z" }), NOW),
    ).toBe("expired");
  });

  it("does not report expired for a future expiry", () => {
    expect(
      apiKeyState(key({ id: "x", expiresAt: "2027-01-01T00:00:00Z" }), NOW),
    ).toBe("live");
  });

  it("reports sandbox for a sandbox-only key", () => {
    expect(apiKeyState(key({ id: "x", sandboxOnly: true }), NOW)).toBe("sandbox");
  });

  it("reports live by default", () => {
    expect(apiKeyState(key({ id: "x" }), NOW)).toBe("live");
  });
});

describe("isHighRiskKey", () => {
  it("flags a live write scope", () => {
    expect(
      isHighRiskKey(key({ id: "x", scopes: ["write:subscribers"] }), NOW),
    ).toBe(true);
  });

  it("flags admin and send scopes", () => {
    expect(isHighRiskKey(key({ id: "x", scopes: ["admin"] }), NOW)).toBe(true);
    expect(
      isHighRiskKey(key({ id: "x", scopes: ["send:transactional"] }), NOW),
    ).toBe(true);
  });

  it("does not flag a read-only key", () => {
    expect(
      isHighRiskKey(
        key({ id: "x", scopes: ["read:reports", "read:campaigns"] }),
        NOW,
      ),
    ).toBe(false);
  });

  it("does not flag an audit scope, which is read-shaped", () => {
    expect(
      isHighRiskKey(key({ id: "x", scopes: ["audit:configure_retention"] }), NOW),
    ).toBe(false);
  });

  it("does not flag a key that is already revoked or expired", () => {
    expect(
      isHighRiskKey(
        key({ id: "x", scopes: ["admin"], revokedAt: "2026-01-01T00:00:00Z" }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isHighRiskKey(
        key({ id: "x", scopes: ["admin"], expiresAt: "2026-01-01T00:00:00Z" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("does not flag a sandbox-only key, which can never send real mail", () => {
    expect(
      isHighRiskKey(
        key({ id: "x", scopes: ["send:transactional"], sandboxOnly: true }),
        NOW,
      ),
    ).toBe(false);
  });
});
