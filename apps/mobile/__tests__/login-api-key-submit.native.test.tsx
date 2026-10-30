/**
 * `app/(auth)/login.tsx` — the API-KEY sign-in submit.
 *
 * This is not the control `auth-screens.native.test.tsx` covers. That file
 * presses `signin-submit` in `SignInFormView` (email + password); this is
 * `login-submit`, the power-user / automation path, and its `onSubmit` is
 * fifty lines of its own with four refusals in front of the network call:
 *
 *   required fields → validateApiBaseUrl → offline → `pw_` prefix → probe
 *
 * The ORDER is the design, not an accident. Each refusal exists to avoid a
 * round trip the client can already prove will fail, and the last one — the
 * probe of `/api/v1/me` — exists so a bad key fails HERE rather than on the
 * first dashboard query, after the credential has been written to the
 * Keychain. That last property is the one worth the most and the one nothing
 * asserted: a probe that rejects must leave the store untouched.
 *
 * `validateApiBaseUrl` runs FOR REAL here (`jest.requireActual` on the source
 * path, past the module map), because the refusal that matters most — plain
 * `http://` to a host that is not localhost — is a security rule, and a stub
 * that answers `{ok:true}` would turn its test into a test of the stub.
 *
 * The only seams are the network (the SDK client) and the store's `signIn`.
 * Both are asserted by their ARGUMENTS.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { router } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Login from "../app/(auth)/login";
import { LAST_BASE_URL_KEY } from "@/lib/authPrefs";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");
const asyncStorage = require("./mocks/asyncStorage.cjs");

const routerReplace = router.replace as unknown as {
  mock: { calls: unknown[][] };
};

/** Everything the screen did to the network, and what it got back. */
const mockSdk: {
  constructed: unknown[];
  requests: { method: string; path: string }[];
  respond: (() => Promise<unknown>) | null;
} = { constructed: [], requests: [], respond: null };

jest.mock("@postwave/sdk", () => {
  const emptyCopy = { body: "Nothing here yet.", title: "No items" };
  class PostwaveClient {
    constructor(options: unknown) {
      mockSdk.constructed.push(options);
    }
    async request(method: string, path: string): Promise<unknown> {
      mockSdk.requests.push({ method, path });
      const respond = mockSdk.respond;
      if (respond) return respond();
      return { data: {}, error: null };
    }
  }
  // Mirrors __tests__/mocks/postwavePackages.cjs: the same file backs
  // `@postwave/onboarding-schema` and `@postwave/telemetry`, so replacing it
  // with a bare `{ PostwaveClient }` would strip those exports from every
  // other importer in this screen's graph.
  const target: Record<string | symbol, unknown> = {
    EMPTY_STATES: new Proxy({}, { get: () => emptyCopy }),
    EVENTS: new Proxy({}, { get: (_t: unknown, property: string | symbol) => String(property) }),
    PostwaveClient,
  };
  return new Proxy(target, {
    get: (t, property) => (property in t ? t[property] : jest.fn()),
  });
});

/**
 * The REAL url policy, not the `{ok:true}` stub the module map installs.
 * `../src/lib/config` sidesteps the `^@/(.*)$` mapping on purpose.
 */
jest.mock("@/lib/config", () => jest.requireActual("../src/lib/config"));

/** The screen imports it at module scope; the paste path is not under test. */
jest.mock("expo-clipboard", () => ({ getStringAsync: async () => null }));

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderLogin() {
  const view = await render(React.createElement(Login), {
    wrapper: ({ children }: { children?: React.ReactNode }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
  // The mount effect reads the remembered server address before the form is
  // stable; typing before it lands would be overwritten by it.
  await flush();
  return view;
}

type LoginView = Awaited<ReturnType<typeof renderLogin>>;

async function fill(
  view: LoginView,
  fields: { baseUrl?: string; tenantId?: string; apiKey?: string },
) {
  if (fields.baseUrl !== undefined) {
    await fireEvent.changeText(
      view.getByTestId("login-base-url"),
      fields.baseUrl,
    );
  }
  if (fields.tenantId !== undefined) {
    await fireEvent.changeText(view.getByTestId("login-tenant"), fields.tenantId);
  }
  if (fields.apiKey !== undefined) {
    await fireEvent.changeText(view.getByTestId("login-api-key"), fields.apiKey);
  }
  await flush();
}

async function submit(view: LoginView) {
  await fireEvent.press(view.getByTestId("login-submit"));
  await flush();
}

/** The store's `signIn` — the moment the credential becomes durable. */
function signInCalls(): unknown[][] {
  const fn = authStore.useAuthStore.getState().signIn as {
    mock: { calls: unknown[][] };
  };
  return fn.mock.calls;
}

beforeEach(async () => {
  mockSdk.constructed.length = 0;
  mockSdk.requests.length = 0;
  mockSdk.respond = null;
  // The AsyncStorage stub is a module-level Map: a base URL remembered by an
  // earlier case would be read back as this one's starting value.
  await asyncStorage.clear();
});

afterEach(() => {
  queryHooks.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
});

describe("api-key sign-in — the refusals before the network", () => {
  it("names all three fields rather than probing with a blank workspace", async () => {
    const view = await renderLogin();

    // A base URL is prefilled; the other two are not.
    await submit(view);

    expect(view.getByText("All three fields are required.")).toBeTruthy();
    expect(mockSdk.requests).toEqual([]);
    expect(signInCalls()).toHaveLength(0);
  });

  it("refuses plain http to a host that is not localhost", async () => {
    const view = await renderLogin();

    await fill(view, {
      baseUrl: "http://api.acme.test",
      tenantId: "acme",
      apiKey: "pw_live_abc123",
    });
    await submit(view);

    // The real policy's own words (lib/config → lib/httpHostPolicy). Posting a
    // long-lived API key over cleartext to an arbitrary host is the failure
    // this refusal exists for.
    expect(
      view.getByText("HTTP is only supported for localhost development APIs."),
    ).toBeTruthy();
    expect(mockSdk.requests).toEqual([]);
    expect(signInCalls()).toHaveLength(0);
  });

  it("refuses a URL carrying credentials or a query string", async () => {
    const view = await renderLogin();

    await fill(view, {
      baseUrl: "https://api.acme.test?tenant=acme",
      tenantId: "acme",
      apiKey: "pw_live_abc123",
    });
    await submit(view);

    expect(
      view.getByText("API URL must not include a query string or fragment."),
    ).toBeTruthy();
    expect(mockSdk.requests).toEqual([]);
  });

  it("says you are offline instead of spending the SDK's timeout", async () => {
    queryHooks.__setIsOnlineForTests(false);
    const view = await renderLogin();

    await fill(view, {
      baseUrl: "https://api.acme.test",
      tenantId: "acme",
      apiKey: "pw_live_abc123",
    });
    await submit(view);

    expect(
      view.getByText(
        "You appear to be offline. Check your connection and try again.",
      ),
    ).toBeTruthy();
    expect(mockSdk.requests).toEqual([]);
    expect(signInCalls()).toHaveLength(0);
  });

  it("catches a key that is not a Moosewave key before a round trip", async () => {
    const view = await renderLogin();

    await fill(view, {
      baseUrl: "https://api.acme.test",
      tenantId: "acme",
      // The classic paste-the-wrong-thing: a session token, not an API key.
      apiKey: "sk_live_abc123",
    });
    await submit(view);

    expect(
      view.getByText(
        "That doesn't look like a Moosewave API key (expected pw_…).",
      ),
    ).toBeTruthy();
    expect(mockSdk.requests).toEqual([]);
    expect(signInCalls()).toHaveLength(0);
  });
});

describe("api-key sign-in — the probe", () => {
  it("probes /api/v1/me with the cleaned credentials, then signs in, remembers the server and enters the app", async () => {
    const view = await renderLogin();

    await fill(view, {
      // Trailing slash and padding on every field: what a paste actually
      // looks like.
      baseUrl: "https://api.acme.test/",
      tenantId: "  acme  ",
      apiKey: "  pw_live_abc123  ",
    });
    await submit(view);

    // One probe, GET, against the identity endpoint — and `retries: 0`, so a
    // rejected key fails at sign-in rather than after three timeouts.
    expect(mockSdk.requests).toEqual([{ method: "GET", path: "/api/v1/me" }]);
    expect(mockSdk.constructed).toEqual([
      {
        apiKey: "pw_live_abc123",
        baseUrl: "https://api.acme.test",
        tenantId: "acme",
        retries: 0,
      },
    ]);
    // The credential becomes durable only after the probe answered, and it is
    // the CLEANED value that is stored — a trailing slash here becomes a
    // double slash in every later request URL.
    expect(signInCalls()).toEqual([
      [
        {
          apiKey: "pw_live_abc123",
          baseUrl: "https://api.acme.test",
          tenantId: "acme",
        },
      ],
    ]);
    // The server address is not a credential and survives sign-out.
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      LAST_BASE_URL_KEY,
      "https://api.acme.test",
    );
    expect(routerReplace.mock.calls).toEqual([["/(tabs)/dashboard"]]);
    expect(view.queryByTestId("login-error")).toBeNull();
  });

  it("does NOT store the credential when the probe rejects the key", async () => {
    mockSdk.respond = async () => {
      throw new Error("HTTP 401");
    };
    const view = await renderLogin();

    await fill(view, {
      baseUrl: "https://api.acme.test",
      tenantId: "acme",
      apiKey: "pw_live_wrong",
    });
    await submit(view);

    expect(mockSdk.requests).toHaveLength(1);
    // The whole point of the probe: nothing durable happened.
    expect(signInCalls()).toHaveLength(0);
    expect(asyncStorage.setItem).not.toHaveBeenCalled();
    expect(routerReplace.mock.calls).toEqual([]);
    expect(
      view.getByText(
        "That key was rejected. Check the key and the workspace it belongs to.",
      ),
    ).toBeTruthy();
  });

  it("turns a bare transport failure into words a human can act on", async () => {
    mockSdk.respond = async () => {
      throw new Error("Network request failed");
    };
    const view = await renderLogin();

    await fill(view, {
      baseUrl: "https://api.acme.test",
      tenantId: "acme",
      apiKey: "pw_live_abc123",
    });
    await submit(view);

    // Not the literal "Network request failed" the SDK threw.
    expect(
      view.getByText(
        "Couldn't reach the server. Check your connection and try again.",
      ),
    ).toBeTruthy();
    expect(signInCalls()).toHaveLength(0);
  });

  it("does not blame the key for a server-side failure", async () => {
    mockSdk.respond = async () => {
      throw new Error("HTTP 503");
    };
    const view = await renderLogin();

    await fill(view, {
      baseUrl: "https://api.acme.test",
      tenantId: "acme",
      apiKey: "pw_live_abc123",
    });
    await submit(view);

    expect(
      view.getByText("Moosewave is temporarily unavailable. Please try again."),
    ).toBeTruthy();
    expect(signInCalls()).toHaveLength(0);
  });

  it("cannot be fired twice while a probe is in flight — by button OR return key", async () => {
    // The store only flips `signingIn` AFTER the probe returns, so without the
    // screen's own `probing` flag a user could queue N concurrent probes over
    // the SDK's 30s window.
    mockSdk.respond = () => new Promise(() => undefined);
    const view = await renderLogin();

    await fill(view, {
      baseUrl: "https://api.acme.test",
      tenantId: "acme",
      apiKey: "pw_live_abc123",
    });
    await submit(view);

    const button = view.getByTestId("login-submit");
    expect(button.props.accessibilityState?.disabled).toBe(true);
    expect(button.props.accessibilityState?.busy).toBe(true);

    await submit(view);
    await submit(view);

    // The button is only half the story. `keyboardChain({ onSubmit })` wires
    // the API-key field's return key straight to the same handler and is NOT
    // disabled while busy, so `if (busy) return` inside onSubmit is the only
    // thing standing between a held return key and N concurrent probes.
    await fireEvent(view.getByTestId("login-api-key"), "submitEditing");
    await fireEvent(view.getByTestId("login-api-key"), "submitEditing");
    await flush();

    expect(mockSdk.requests).toHaveLength(1);
  });
});
