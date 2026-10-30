import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hint: null as { user_id: string; tenant_id: string } | null,
  offlineIdentity: null as string | null,
}));

vi.mock("../../lib/api-client", () => ({
  getRememberedSession: () => state.hint,
}));

vi.mock("../../lib/offline-store", () => ({
  getOfflineIdentity: () => state.offlineIdentity,
}));

vi.mock("../../lib/online-manager", () => ({
  getOnlineStatus: () => "online",
}));

vi.mock("../../lib/outbox", () => ({
  installOutboxMutationDefaults: vi.fn(),
}));

import { buildCacheBuster } from "../../lib/query-client";

beforeEach(() => {
  state.hint = null;
  state.offlineIdentity = null;
});

describe("desktop query-cache identity buster", () => {
  it("uses the authoritative user and tenant when resolved", () => {
    expect(buildCacheBuster("user-a", "tenant-a")).toMatch(
      /:user-a:tenant-a$/,
    );
  });

  it("uses the remembered session during a cookie-session cold boot", () => {
    state.hint = { user_id: "user-hint", tenant_id: "tenant-hint" };
    expect(buildCacheBuster(null, null)).toMatch(
      /:user-hint:tenant-hint$/,
    );
  });

  it("scopes API-key cold boots to the broker-derived workspace identity", () => {
    state.offlineIdentity = `apikey:native:${"a".repeat(64)}`;
    expect(buildCacheBuster(null, null)).toMatch(
      new RegExp(`:offline:apikey:native:${"a".repeat(64)}$`),
    );
  });

  it("keeps true pre-auth state in an anonymous partition", () => {
    expect(buildCacheBuster(null, null)).toMatch(/:offline:anon$/);
  });
});
