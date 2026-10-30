import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CANONICAL_USER_ID = "11111111-1111-4111-8111-111111111111";
const CANONICAL_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const API_BASE_URL = "https://api.example.test/path-gateway";

const posthog = vi.hoisted(() => {
  const state: {
    optedOut: boolean;
    loadPromise: Promise<void>;
  } = {
    optedOut: true,
    loadPromise: Promise.resolve(),
  };
  const client = {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    opt_in_capturing: vi.fn(() => {
      state.optedOut = false;
    }),
    opt_out_capturing: vi.fn(() => {
      state.optedOut = true;
    }),
    has_opted_out_capturing: vi.fn(() => state.optedOut),
  };
  return {
    client,
    moduleLoads: vi.fn(),
    state,
  };
});

const opaqueIdentity = vi.hoisted(() => ({
  derive:
    vi.fn<(namespace: string, logicalKey: string) => Promise<string | null>>(),
}));

vi.mock("../../lib/opaque-vault-key", () => ({
  opaqueVaultKey: opaqueIdentity.derive,
}));

vi.mock("posthog-js/dist/module.slim.js", async () => {
  posthog.moduleLoads();
  await posthog.state.loadPromise;
  return { default: posthog.client };
});

function makeStorage(
  initial: Record<string, string> = {},
  options: { denyWrites?: boolean } = {},
): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (options.denyWrites) throw new Error("storage denied");
      values.set(key, value);
    },
  };
}

function makeCookieJar(initial: Record<string, string> = {}): {
  document: Document;
  has(name: string): boolean;
} {
  const values = new Map(Object.entries(initial));
  const stub = {} as Document;
  Object.defineProperty(stub, "documentElement", {
    configurable: true,
    value: {
      removeAttribute: vi.fn(),
      setAttribute: vi.fn(),
      style: { colorScheme: "" },
    },
  });
  Object.defineProperty(stub, "cookie", {
    configurable: true,
    get: () =>
      Array.from(values, ([name, value]) => `${name}=${value}`).join("; "),
    set: (serialized: string) => {
      const [pair] = serialized.split(";", 1);
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/u.test(serialized)) {
        values.delete(name);
      } else {
        values.set(name, pair.slice(separator + 1));
      }
    },
  });
  return {
    document: stub,
    has: (name: string) => values.has(name),
  };
}

async function loadTelemetry() {
  const telemetry = await import("../../lib/telemetry");
  const { observeApiAuthority } = await import("../../lib/api-authority");
  observeApiAuthority(API_BASE_URL);
  return {
    ...telemetry,
    identifyWorkspace: (
      user: string | null | undefined,
      tenant: string | null | undefined,
      apiBaseUrl = API_BASE_URL,
    ) => telemetry.identifyWorkspace(user, tenant, apiBaseUrl),
  };
}

describe("desktop telemetry consent boundary", () => {
  let localStorage: Storage;
  let sessionStorage: Storage;
  let cookies: ReturnType<typeof makeCookieJar>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    opaqueIdentity.derive.mockResolvedValue(
      `telemetry-identity:sha256:${"a".repeat(64)}`,
    );
    posthog.state.optedOut = true;
    posthog.state.loadPromise = Promise.resolve();
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_desktop_test");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://telemetry.example.test");
    localStorage = makeStorage();
    sessionStorage = makeStorage();
    cookies = makeCookieJar();
    vi.stubGlobal("window", {
      localStorage,
      sessionStorage,
      location: {
        hostname: "desktop.postwave.test",
        pathname: "/app/helpdesk",
        search: "",
        href: "https://desktop.postwave.test/app/helpdesk",
      },
    });
    vi.stubGlobal("document", cookies.document);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("defaults unset consent to denied without loading PostHog and purges only SDK artifacts", async () => {
    localStorage.setItem("ph_old-token_posthog", "identity");
    localStorage.setItem("__ph_opt_in_out_old-token", "1");
    localStorage.setItem("ph_conv_old-token", "conversation");
    localStorage.setItem("inProgressSurvey_survey-id", "response");
    localStorage.setItem("_postHogToolbarParams", "token");
    localStorage.setItem("ph_product_tour_shown_tour-id", "true");
    localStorage.setItem("ph_unrelated", "safe");
    localStorage.setItem("postwave.keep", "safe");
    sessionStorage.setItem("ph_old-token_window_id", "window");
    sessionStorage.setItem("keep.session", "safe");
    cookies = makeCookieJar({
      "ph_old-token_posthog": "identity",
      "__ph_opt_in_out_old-token": "1",
      keep_cookie: "safe",
    });
    vi.stubGlobal("document", cookies.document);

    const telemetry = await loadTelemetry();
    await telemetry.init();

    expect(posthog.moduleLoads).not.toHaveBeenCalled();
    expect(posthog.client.init).not.toHaveBeenCalled();
    expect(telemetry.getOptOut()).toBe(true);
    expect(telemetry.isEnabled()).toBe(false);
    expect(localStorage.getItem("ph_old-token_posthog")).toBeNull();
    expect(localStorage.getItem("__ph_opt_in_out_old-token")).toBeNull();
    expect(localStorage.getItem("ph_conv_old-token")).toBeNull();
    expect(localStorage.getItem("inProgressSurvey_survey-id")).toBeNull();
    expect(localStorage.getItem("_postHogToolbarParams")).toBeNull();
    expect(localStorage.getItem("ph_product_tour_shown_tour-id")).toBeNull();
    expect(sessionStorage.getItem("ph_old-token_window_id")).toBeNull();
    expect(localStorage.getItem("postwave.keep")).toBe("safe");
    expect(localStorage.getItem("ph_unrelated")).toBe("safe");
    expect(sessionStorage.getItem("keep.session")).toBe("safe");
    expect(cookies.has("ph_old-token_posthog")).toBe(false);
    expect(cookies.has("__ph_opt_in_out_old-token")).toBe(false);
    expect(cookies.has("keep_cookie")).toBe(true);
  });

  it.each(["1", "unexpected"])(
    "keeps persisted %s consent denied before dynamic import",
    async (stored) => {
      localStorage.setItem("postwave_telemetry_optout", stored);
      const telemetry = await loadTelemetry();

      await telemetry.init();
      telemetry.track("denied_event");
      await telemetry.identifyWorkspace("denied_user", "denied_tenant");

      expect(posthog.moduleLoads).not.toHaveBeenCalled();
      expect(posthog.client.capture).not.toHaveBeenCalled();
      expect(posthog.client.identify).not.toHaveBeenCalled();
    },
  );

  it("cancels an in-flight first load when consent is revoked", async () => {
    let releaseModule!: () => void;
    posthog.state.loadPromise = new Promise<void>((resolve) => {
      releaseModule = resolve;
    });
    const telemetry = await loadTelemetry();

    const granting = telemetry.setOptOut(false);
    await vi.waitFor(() => expect(posthog.moduleLoads).toHaveBeenCalledOnce());
    const revoking = telemetry.setOptOut(true);
    releaseModule();
    await Promise.all([granting, revoking]);

    expect(posthog.client.init).not.toHaveBeenCalled();
    expect(telemetry.isEnabled()).toBe(false);
  });

  it("lazily initializes on grant with opt-out defaults and memory-only persistence", async () => {
    const telemetry = await loadTelemetry();
    expect(posthog.client.init).not.toHaveBeenCalled();

    await telemetry.setOptOut(false);

    expect(localStorage.getItem("postwave_telemetry_optout")).toBe("0");
    expect(posthog.client.init).toHaveBeenCalledWith(
      "phc_desktop_test",
      expect.objectContaining({
        api_host: "https://telemetry.example.test",
        advanced_disable_feature_flags: true,
        advanced_disable_flags: true,
        autocapture: false,
        capture_pageleave: false,
        capture_pageview: false,
        disable_conversations: true,
        disable_external_dependency_loading: true,
        disable_session_recording: true,
        disable_surveys: true,
        opt_out_capturing_by_default: true,
        opt_out_persistence_by_default: true,
        persistence: "memory",
        respect_dnt: true,
      }),
    );
    expect(posthog.client.opt_in_capturing).toHaveBeenCalledWith({
      captureEventName: false,
    });
    expect(telemetry.isEnabled()).toBe(true);
  });

  it("keeps grant a no-op when the build has no PostHog key", async () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    const telemetry = await loadTelemetry();

    await telemetry.setOptOut(false);
    await telemetry.init();
    telemetry.track("no_key_event");

    expect(posthog.moduleLoads).not.toHaveBeenCalled();
    expect(posthog.client.capture).not.toHaveBeenCalled();
    expect(telemetry.isEnabled()).toBe(false);
  });

  it("gates capture and identify before grant and after revocation", async () => {
    const telemetry = await loadTelemetry();
    telemetry.track("before_grant");
    await telemetry.identifyWorkspace("before-grant", "before-tenant");

    await telemetry.setOptOut(false);
    telemetry.track("granted_event", { count: 2 });
    await telemetry.identifyWorkspace(CANONICAL_USER_ID, CANONICAL_TENANT_ID);

    localStorage.setItem("ph_phc_desktop_test_posthog", "identity");
    sessionStorage.setItem("ph_phc_desktop_test_primary_window_exists", "1");
    localStorage.setItem("unrelated", "keep");
    cookies.document.cookie = "ph_phc_desktop_test_posthog=identity";
    cookies.document.cookie = "keep_cookie=safe";
    await telemetry.setOptOut(true);
    telemetry.track("after_revoke");
    await telemetry.identifyWorkspace("after-revoke", "after-tenant");

    expect(posthog.client.capture).toHaveBeenCalledTimes(1);
    expect(posthog.client.capture).toHaveBeenCalledWith("granted_event", {
      count: 2,
    });
    expect(posthog.client.identify).toHaveBeenCalledTimes(1);
    expect(posthog.client.identify).toHaveBeenCalledWith(
      expect.stringMatching(/^telemetry-identity:sha256:[a-f0-9]{64}$/u),
    );
    expect(JSON.stringify(posthog.client.identify.mock.calls)).not.toContain(
      CANONICAL_USER_ID,
    );
    expect(JSON.stringify(posthog.client.identify.mock.calls)).not.toContain(
      CANONICAL_TENANT_ID,
    );
    expect(posthog.client.opt_out_capturing).toHaveBeenCalledTimes(2);
    expect(posthog.client.reset).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("postwave_telemetry_optout")).toBe("1");
    expect(localStorage.getItem("ph_phc_desktop_test_posthog")).toBeNull();
    expect(
      sessionStorage.getItem("ph_phc_desktop_test_primary_window_exists"),
    ).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(cookies.has("ph_phc_desktop_test_posthog")).toBe(false);
    expect(cookies.has("keep_cookie")).toBe(true);
    expect(telemetry.isEnabled()).toBe(false);
  });

  it("suppresses capture and identify whenever the shared URL redactor would change the route", async () => {
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);
    const location = window.location as unknown as {
      href: string;
      pathname: string;
      search: string;
    };
    const setRoute = (pathname: string, search = ""): void => {
      location.pathname = pathname;
      location.search = search;
      location.href = `https://desktop.postwave.test${pathname}${search}`;
    };

    for (const [pathname, search] of [
      ["/app/helpdesk/11111111-1111-4111-8111-111111111111", ""],
      ["/app/helpdesk", "?q=private.person%40example.test"],
      ["/app/helpdesk", "?email=private.person%40example.test"],
      ["/app/helpdesk", "?cursor=opaque-cursor"],
    ] as const) {
      posthog.client.capture.mockClear();
      posthog.client.identify.mockClear();
      setRoute(pathname, search);
      telemetry.track("sensitive_route_event");
      await telemetry.identifyWorkspace(CANONICAL_USER_ID, CANONICAL_TENANT_ID);
      expect(posthog.client.capture).not.toHaveBeenCalled();
      expect(posthog.client.identify).not.toHaveBeenCalled();
    }

    setRoute("/app/helpdesk");
    telemetry.track("safe_helpdesk_event");
    await telemetry.identifyWorkspace(CANONICAL_USER_ID, CANONICAL_TENANT_ID);
    expect(posthog.client.capture).toHaveBeenCalledWith(
      "safe_helpdesk_event",
      undefined,
    );
    expect(posthog.client.identify).toHaveBeenCalledTimes(1);
  });

  it("does not initialize PostHog on a direct sensitive Helpdesk route", async () => {
    const location = window.location as unknown as {
      href: string;
      pathname: string;
      search: string;
    };
    location.pathname = "/app/helpdesk/11111111-1111-4111-8111-111111111111";
    location.search = "?q=private.person%40example.test";
    location.href = `https://desktop.postwave.test${location.pathname}${location.search}`;
    localStorage.setItem("postwave_telemetry_optout", "0");
    const telemetry = await loadTelemetry();

    await telemetry.init();
    telemetry.track("app_opened");
    await telemetry.identifyWorkspace(CANONICAL_USER_ID, CANONICAL_TENANT_ID);

    expect(posthog.moduleLoads).not.toHaveBeenCalled();
    expect(posthog.client.capture).not.toHaveBeenCalled();
    expect(posthog.client.identify).not.toHaveBeenCalled();
  });

  it("accepts only a canonical UUID pair after provenance qualification", async () => {
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);

    for (const [user, tenant] of [
      ["actor@example.test", CANONICAL_TENANT_ID],
      ["claude-code", CANONICAL_TENANT_ID],
      ["api-key", CANONICAL_TENANT_ID],
      [CANONICAL_USER_ID, "workspace-label"],
    ] as const) {
      await telemetry.identifyWorkspace(user, tenant);
    }
    expect(posthog.client.identify).not.toHaveBeenCalled();

    await telemetry.identifyWorkspace(CANONICAL_USER_ID, CANONICAL_TENANT_ID);
    expect(posthog.client.identify).toHaveBeenCalledTimes(1);
    expect(posthog.client.identify).toHaveBeenCalledWith(
      expect.stringMatching(/^telemetry-identity:sha256:[a-f0-9]{64}$/u),
    );
  });

  it("suppresses a delayed prior identity after an A to B transition", async () => {
    const nextUser = "33333333-3333-4333-8333-333333333333";
    const nextTenant = "44444444-4444-4444-8444-444444444444";
    let releaseFirst!: (value: string) => void;
    opaqueIdentity.derive
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(`telemetry-identity:sha256:${"b".repeat(64)}`);
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);

    const first = telemetry.identifyWorkspace(
      CANONICAL_USER_ID,
      CANONICAL_TENANT_ID,
    );
    await vi.waitFor(() =>
      expect(opaqueIdentity.derive).toHaveBeenCalledOnce(),
    );
    await telemetry.identifyWorkspace(nextUser, nextTenant);
    releaseFirst(`telemetry-identity:sha256:${"a".repeat(64)}`);
    await first;

    expect(posthog.client.identify).toHaveBeenCalledTimes(1);
    expect(posthog.client.identify).toHaveBeenCalledWith(
      `telemetry-identity:sha256:${"b".repeat(64)}`,
    );
  });

  it("resets an established identity before an A to B transition", async () => {
    const nextUser = "33333333-3333-4333-8333-333333333333";
    const nextTenant = "44444444-4444-4444-8444-444444444444";
    opaqueIdentity.derive
      .mockResolvedValueOnce(`telemetry-identity:sha256:${"a".repeat(64)}`)
      .mockResolvedValueOnce(`telemetry-identity:sha256:${"b".repeat(64)}`);
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);

    await telemetry.identifyWorkspace(CANONICAL_USER_ID, CANONICAL_TENANT_ID);
    await telemetry.identifyWorkspace(nextUser, nextTenant);

    expect(posthog.client.identify.mock.calls).toEqual([
      [`telemetry-identity:sha256:${"a".repeat(64)}`],
      [`telemetry-identity:sha256:${"b".repeat(64)}`],
    ]);
    expect(posthog.client.reset).toHaveBeenCalledTimes(1);
    expect(posthog.client.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.client.identify.mock.invocationCallOrder[1]!,
    );
  });

  it("separates identical session UUIDs by full API base and resets on direct Settings change", async () => {
    const nextApiBase = "https://staging.example.test/other-gateway";
    localStorage.setItem("postwave_api_url", API_BASE_URL);
    opaqueIdentity.derive
      .mockResolvedValueOnce(`telemetry-identity:sha256:${"a".repeat(64)}`)
      .mockResolvedValueOnce(`telemetry-identity:sha256:${"b".repeat(64)}`);
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);
    await telemetry.identifyWorkspace(
      CANONICAL_USER_ID,
      CANONICAL_TENANT_ID,
      API_BASE_URL,
    );

    const { setApiConfig } = await import("../../lib/api-client");
    await setApiConfig(nextApiBase);

    expect(posthog.client.reset).toHaveBeenCalledTimes(1);
    telemetry.track("anonymous_after_direct_api_base_change");
    expect(posthog.client.capture).toHaveBeenCalledWith(
      "anonymous_after_direct_api_base_change",
      undefined,
    );
    expect(posthog.client.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.client.capture.mock.invocationCallOrder[0]!,
    );

    // Only a newly provenance-qualified /auth/me identity may install at B.
    await telemetry.identifyWorkspace(
      CANONICAL_USER_ID,
      CANONICAL_TENANT_ID,
      nextApiBase,
    );
    expect(posthog.client.identify.mock.calls).toEqual([
      [`telemetry-identity:sha256:${"a".repeat(64)}`],
      [`telemetry-identity:sha256:${"b".repeat(64)}`],
    ]);
    expect(opaqueIdentity.derive.mock.calls[0]?.[1]).not.toBe(
      opaqueIdentity.derive.mock.calls[1]?.[1],
    );
  });

  it("resets synchronously on a same-base bearer replacement without emitting raw authority", async () => {
    localStorage.setItem("postwave_api_url", API_BASE_URL);
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);
    await telemetry.identifyWorkspace(
      CANONICAL_USER_ID,
      CANONICAL_TENANT_ID,
      API_BASE_URL,
    );

    const { setApiConfig } = await import("../../lib/api-client");
    await setApiConfig(API_BASE_URL, "pw_same_base_private_replacement");
    telemetry.track("anonymous_after_same_base_credential_change");

    expect(posthog.client.reset).toHaveBeenCalledTimes(1);
    expect(posthog.client.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.client.capture.mock.invocationCallOrder[0]!,
    );
    expect(posthog.client.capture).toHaveBeenCalledWith(
      "anonymous_after_same_base_credential_change",
      undefined,
    );
    const externalTelemetry = JSON.stringify({
      captures: posthog.client.capture.mock.calls,
      identifies: posthog.client.identify.mock.calls,
    });
    expect(externalTelemetry).not.toContain(API_BASE_URL);
    expect(externalTelemetry).not.toContain(CANONICAL_USER_ID);
    expect(externalTelemetry).not.toContain(CANONICAL_TENANT_ID);
    expect(externalTelemetry).not.toContain("pw_same_base_private_replacement");
  });

  it("resets an established identity when session provenance becomes absent", async () => {
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);
    await telemetry.identifyWorkspace(CANONICAL_USER_ID, CANONICAL_TENANT_ID);

    await telemetry.identifyWorkspace(null, null);
    telemetry.track("anonymous_after_api_key_fallback");

    expect(posthog.client.identify).toHaveBeenCalledTimes(1);
    expect(posthog.client.reset).toHaveBeenCalledTimes(1);
    expect(posthog.client.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.client.capture.mock.invocationCallOrder[0]!,
    );
    expect(posthog.client.capture).toHaveBeenCalledWith(
      "anonymous_after_api_key_fallback",
      undefined,
    );
    expect(telemetry.isEnabled()).toBe(true);
  });

  it("clears a changed identity even while the Helpdesk location is sensitive", async () => {
    const nextUser = "33333333-3333-4333-8333-333333333333";
    const nextTenant = "44444444-4444-4444-8444-444444444444";
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);
    await telemetry.identifyWorkspace(CANONICAL_USER_ID, CANONICAL_TENANT_ID);
    const location = window.location as unknown as {
      href: string;
      pathname: string;
      search: string;
    };
    location.pathname = "/app/helpdesk/11111111-1111-4111-8111-111111111111";
    location.search = "?q=private.person%40example.test";
    location.href = `https://desktop.postwave.test${location.pathname}${location.search}`;

    await telemetry.identifyWorkspace(nextUser, nextTenant);
    expect(posthog.client.reset).toHaveBeenCalledTimes(1);
    expect(posthog.client.identify).toHaveBeenCalledTimes(1);

    location.pathname = "/app/helpdesk";
    location.search = "";
    location.href = "https://desktop.postwave.test/app/helpdesk";
    telemetry.track("anonymous_after_sensitive_transition");
    expect(posthog.client.capture).toHaveBeenCalledWith(
      "anonymous_after_sensitive_transition",
      undefined,
    );
    expect(posthog.client.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.client.capture.mock.invocationCallOrder[0]!,
    );
  });

  it("invalidates a delayed session identity when provenance becomes absent", async () => {
    let release!: (value: string) => void;
    opaqueIdentity.derive.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);

    const pending = telemetry.identifyWorkspace(
      CANONICAL_USER_ID,
      CANONICAL_TENANT_ID,
    );
    await vi.waitFor(() =>
      expect(opaqueIdentity.derive).toHaveBeenCalledOnce(),
    );
    await telemetry.identifyWorkspace(null, null);
    release(`telemetry-identity:sha256:${"a".repeat(64)}`);
    await pending;

    expect(posthog.client.identify).not.toHaveBeenCalled();
  });

  it("fails a grant closed when localStorage cannot persist it", async () => {
    localStorage = makeStorage({}, { denyWrites: true });
    vi.stubGlobal("window", {
      localStorage,
      sessionStorage,
      location: { hostname: "desktop.postwave.test" },
    });
    const telemetry = await loadTelemetry();

    await telemetry.setOptOut(false);

    expect(posthog.moduleLoads).not.toHaveBeenCalled();
    expect(telemetry.getOptOut()).toBe(true);
    expect(telemetry.isEnabled()).toBe(false);
  });

  it("emits structural diagnostics without interpolating SDK errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);
    posthog.client.capture.mockImplementationOnce(() => {
      throw new Error("subscriber@example.com secret-token");
    });

    telemetry.track("safe_event");

    expect(warn).toHaveBeenCalledWith("[postwave-telemetry] capture failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "subscriber@example.com",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token");
    warn.mockRestore();
  });

  it("reset clears SDK identity artifacts while preserving device consent", async () => {
    const telemetry = await loadTelemetry();
    await telemetry.setOptOut(false);
    localStorage.setItem("ph_phc_desktop_test_posthog", "identity");
    sessionStorage.setItem("ph_phc_desktop_test_window_id", "window");
    localStorage.setItem("postwave.keep", "safe");

    telemetry.reset();
    telemetry.track("after_reset");

    expect(posthog.client.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(posthog.client.reset).toHaveBeenCalledTimes(1);
    expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("postwave_telemetry_optout")).toBe("0");
    expect(localStorage.getItem("ph_phc_desktop_test_posthog")).toBeNull();
    expect(sessionStorage.getItem("ph_phc_desktop_test_window_id")).toBeNull();
    expect(localStorage.getItem("postwave.keep")).toBe("safe");
    expect(posthog.client.capture).toHaveBeenCalledWith(
      "after_reset",
      undefined,
    );
    expect(telemetry.isEnabled()).toBe(true);
  });
});
