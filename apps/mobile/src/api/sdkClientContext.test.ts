/**
 * `getClient()` — the memoised SDK context every api module reaches through.
 *
 * WHY THIS FILE EXISTS (NATIVE#51). The interceptors around the transport were
 * covered by sdkClient.test.ts; the FACTORY was not, and it is the more
 * dangerous half. It caches one PostwaveClient behind a composite key, so a
 * key that omits any identity dimension hands the previous workspace's client
 * to the next one — the same identity-hygiene failure the web audit found on a
 * shared browser, except a phone's account switcher makes it a one-tap bug.
 *
 * The SDK is mocked so the constructor OPTIONS are observable. Those options
 * are not cosmetic: `credentials: "include"` on an API-key client would attach
 * an unrelated user's cookie, and `defaultHeaders` is what exempts the app from
 * the backend's Origin/CSRF gate (apps/api/internal/middleware/origin_csrf.go).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type ConstructedOptions = {
  apiKey?: string;
  authMode?: string;
  tenantSlug?: string;
  baseUrl?: string;
  credentials?: string;
  defaultHeaders?: Record<string, string>;
};

const constructed = vi.hoisted(() => [] as ConstructedOptions[]);

const authState = vi.hoisted(() => ({
  current: {
    apiKey: null as string | null,
    baseUrl: null as string | null,
    mode: null as string | null,
    session: null as {
      tenantId?: string;
      workspaceSlug?: string;
    } | null,
    tenantId: null as string | null,
  },
}));

vi.mock("@postwave/sdk", () => ({
  PostwaveClient: vi.fn(function PostwaveClientMock(
    this: { options: ConstructedOptions },
    options: ConstructedOptions,
  ) {
    constructed.push(options);
    this.options = options;
  }),
}));
vi.mock("@/store/auth", () => ({
  useAuthStore: { getState: () => authState.current },
}));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));

// eslint-disable-next-line import/first
import { clearClient, getClient } from "./sdkClient";
// eslint-disable-next-line import/first
import { NATIVE_CLIENT_HEADERS } from "./nativeClient";

function signInSession(overrides: Partial<typeof authState.current> = {}): void {
  authState.current = {
    apiKey: null,
    baseUrl: "https://api.moosewave.com",
    mode: "session",
    session: { tenantId: "tenant-a", workspaceSlug: "acme" },
    tenantId: "tenant-a",
    ...overrides,
  };
}

describe("getClient credential gate", () => {
  beforeEach(() => {
    constructed.length = 0;
    clearClient();
    authState.current = {
      apiKey: null,
      baseUrl: null,
      mode: null,
      session: null,
      tenantId: null,
    };
  });

  it("refuses to mint a client while logged out", () => {
    expect(() => getClient()).toThrow(/without credentials/i);
    expect(constructed).toHaveLength(0);
  });

  it("refuses during partial hydration — a host but no tenant yet", () => {
    authState.current = {
      apiKey: null,
      baseUrl: "https://api.moosewave.com",
      mode: "session",
      session: null,
      tenantId: null,
    };
    expect(() => getClient()).toThrow(/without credentials/i);
  });

  it("falls back to the session tenant when the store field is unset", () => {
    authState.current = {
      apiKey: null,
      baseUrl: "https://api.moosewave.com",
      mode: "session",
      session: { tenantId: "tenant-from-session", workspaceSlug: "acme" },
      tenantId: null,
    };
    expect(getClient().tenantId).toBe("tenant-from-session");
  });

  it("infers api_key mode from a bare key when mode never hydrated", () => {
    authState.current = {
      apiKey: "pw_live_key",
      baseUrl: "https://api.moosewave.com",
      mode: null,
      session: null,
      tenantId: "tenant-a",
    };
    getClient();
    expect(constructed[0]?.authMode).toBe("api_key");
  });
});

describe("getClient memoisation", () => {
  beforeEach(() => {
    constructed.length = 0;
    clearClient();
    signInSession();
  });

  it("reuses one client for repeated calls on unchanged auth state", () => {
    const first = getClient();
    const second = getClient();
    expect(second).toBe(first);
    expect(constructed).toHaveLength(1);
  });

  it("mints a NEW client when the tenant changes", () => {
    // The cross-tenant bleed guard. Serving the cached tenant-a client to
    // tenant-b would send tenant-a's slug header on every tenant-b request.
    const first = getClient();
    signInSession({
      session: { tenantId: "tenant-b", workspaceSlug: "globex" },
      tenantId: "tenant-b",
    });
    const second = getClient();

    expect(second).not.toBe(first);
    expect(second.tenantId).toBe("tenant-b");
    expect(constructed.map((options) => options.tenantSlug)).toEqual([
      "acme",
      "globex",
    ]);
  });

  it("mints a NEW client when the server host changes", () => {
    const first = getClient();
    signInSession({ baseUrl: "https://staging.moosewave.com" });
    expect(getClient()).not.toBe(first);
  });

  it("mints a NEW client when the API key is rotated", () => {
    authState.current = {
      apiKey: "key-one",
      baseUrl: "https://api.moosewave.com",
      mode: "api_key",
      session: null,
      tenantId: "tenant-a",
    };
    const first = getClient();
    authState.current = { ...authState.current, apiKey: "key-two" };
    const second = getClient();

    expect(second).not.toBe(first);
    expect(constructed.map((options) => options.apiKey)).toEqual([
      "key-one",
      "key-two",
    ]);
  });

  it("forgets the cached client after clearClient (logout)", () => {
    const first = getClient();
    clearClient();
    expect(getClient()).not.toBe(first);
    expect(constructed).toHaveLength(2);
  });
});

describe("getClient transport options", () => {
  beforeEach(() => {
    constructed.length = 0;
    clearClient();
  });

  it("sends the cookie and the workspace slug in session mode", () => {
    signInSession();
    getClient();

    expect(constructed[0]).toMatchObject({
      authMode: "session",
      baseUrl: "https://api.moosewave.com",
      credentials: "include",
      tenantSlug: "acme",
    });
    expect(constructed[0]?.apiKey).toBeUndefined();
  });

  it("never attaches cookies to an API-key client", () => {
    // A bearer client that also sent `credentials: include` would ride an
    // unrelated signed-in user's session cookie on the same host.
    authState.current = {
      apiKey: "pw_live_key",
      baseUrl: "https://api.moosewave.com",
      mode: "api_key",
      session: null,
      tenantId: "acme",
    };
    getClient();

    expect(constructed[0]?.credentials).toBeUndefined();
    expect(constructed[0]).toMatchObject({
      apiKey: "pw_live_key",
      authMode: "api_key",
      // API-key installs carry the tenant as the slug, since there is no
      // session workspace to read it from.
      tenantSlug: "acme",
    });
  });

  it("always declares the first-party native client headers", () => {
    signInSession();
    getClient();
    expect(constructed[0]?.defaultHeaders).toBe(NATIVE_CLIENT_HEADERS);
  });
});
