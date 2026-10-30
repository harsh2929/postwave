/**
 * Device sign-in — the render contract for the screen a brand-new phone lands on.
 *
 * WHY THIS FILE EXISTS. `app/(auth)/device-sign-in.tsx` had never been mounted
 * by anything. The lifecycle suite next door (`device-session-sign-in.native
 * .test.tsx`) drives the HOOK through `renderHook`, and `auth-screens.native
 * .test.tsx` renders `DeviceSessionSignInView` with a hand-built `waiting`
 * state — so the file that wires those two halves together, and the only place
 * the base URL, the remember switch and the grant lifecycle meet, had never
 * rendered. That is not a theoretical gap in this programme: `MaintenanceBanner`
 * shipped with 31 policy tests and crashed the whole dashboard on first render
 * with "windows.find is not a function".
 *
 * The screen owns no `useQuery`, so the wire is faked one layer lower, at
 * `authRequest` — the same seam `auth-screens.native.test.tsx` uses. That keeps
 * the REAL `parseDeviceSessionGrantStart` in the path, which is the point:
 * mocking `@/api/deviceSessionSignIn` would hand the screen a grant shape only
 * this test knows how to build, and the strictest thing standing between the
 * server's JSON and the QR on screen is exactly that parser.
 *
 * WHAT THIS PROTECTS. Every assertion is a wrong SENTENCE or a crash, on the
 * one screen where a wrong sentence either locks somebody out of their account
 * or puts a live credential on a bystander's screen:
 *
 *   - `device_code` is a bearer secret. Rendering it anywhere — a label, the
 *     QR payload, the countdown copy — hands the session to whoever is looking
 *     over the shoulder, and this screen exists to show a code to a room.
 *   - A matching code with "Waiting for approval" under it, shown because the
 *     start request FAILED, makes somebody wait for a code no device can ever
 *     approve. That is this screen's version of telling you that you have no
 *     API keys because the request 500'd.
 *   - "Connecting to …" names the origin the session will be minted against. A
 *     self-hosted operator shown the SaaS default is being told the wrong thing
 *     about where their credential is about to live.
 *   - The switch promises either a persistent session or one the server kills
 *     within 12 hours. The screen must REQUEST what it just promised, and must
 *     keep promising the same thing once the code is on screen.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ExpoRouter from "expo-router";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { LAST_BASE_URL_KEY } from "@/lib/authPrefs";

import DeviceSignIn from "../app/(auth)/device-sign-in";

/**
 * The LIVE config module, not a namespace import. `@/lib/config` is a CommonJS
 * test double with no `__esModule` flag, so `import * as Config` hands back an
 * interop COPY and a spy on it patches nothing the screen can see — which is
 * how a test like the last one in this file passes while asserting nothing.
 */
const config = jest.requireActual("@/lib/config") as typeof import("@/lib/config");

interface WireCall {
  baseUrl: string;
  path: string;
  body: Record<string, unknown>;
}

/** `mock`-prefixed so babel-plugin-jest-hoist lets the factory below reach them. */
const mockAuthCalls: WireCall[] = [];
const mockWire: { start: { data?: unknown; error?: unknown } } = { start: {} };

// The wire seam. `authRequest` is the single function every device-grant call
// goes through, so faking it here leaves the real request builder, the real
// grant parser and the real polling lifecycle in the path.
jest.mock("@/api/auth", () => ({
  createAuthClient: () => ({ getMe: async () => ({ data: {} }) }),
  authRequest: async (
    baseUrl: string,
    path: string,
    init?: { body?: string },
  ) => {
    const body = (
      init?.body ? JSON.parse(init.body) : {}
    ) as Record<string, unknown>;
    mockAuthCalls.push({ baseUrl, path, body });
    if (path.endsWith("/device/start")) return mockWire.start;
    // What the server answers on the token endpoint while the other device has
    // not decided yet. Polling is scheduled `interval` seconds out, so no test
    // here reaches it — this only keeps the lifecycle from treating an
    // undefined result as a malformed 200.
    return {
      error: {
        code: "authorization_pending",
        kind: "http",
        status: 400,
        message: "authorization pending",
      },
    };
  },
}));

import {
  clearInAppOrigin,
  depositInAppOrigin,
} from "@/lib/inAppOriginHandoff";
import { DEFAULT_API_BASE_URL } from "@/lib/config";

const routeParams = ExpoRouter as unknown as {
  __setSearchParamsForTests: (over: Record<string, string> | null) => void;
};

const API_BASE_URL = "https://api.example.test";
const SELF_HOSTED_BASE_URL = "https://postwave.internal.acme.test";
/** The config mock's `PUBLIC_APP_BASE_URL`; approval links are pinned to it. */
const APP_ORIGIN = "https://app.moosewave.com";
const USER_CODE = "BCDF-GHJK";
/** Distinctive on purpose: the whole rendered tree is searched for it. */
const DEVICE_CODE = "device-code-bearer-secret-never-render-this";

/** A start response shaped exactly as handlers.go marshals one. */
function grantBody(overrides: Record<string, unknown> = {}) {
  return {
    grant_kind: "session",
    remember: false,
    device_code: DEVICE_CODE,
    user_code: USER_CODE,
    expires_in: 600,
    interval: 5,
    verification_uri: `${APP_ORIGIN}/cli/auth`,
    verification_uri_complete: `${APP_ORIGIN}/cli/auth?user_code=${USER_CODE}`,
    ...overrides,
  };
}

beforeEach(async () => {
  mockAuthCalls.length = 0;
  mockWire.start = { data: grantBody() };
  await AsyncStorage.clear();
  routeParams.__setSearchParamsForTests({ base_url: API_BASE_URL });
});

afterEach(() => {
  // `clearMocks` resets jest.fn()s, not module state: a leftover param would
  // render the next screen against another test's server.
  routeParams.__setSearchParamsForTests(null);
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

async function pressStart(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId("device-signin-start"));
  });
}

function startCall(): WireCall | undefined {
  return mockAuthCalls.find((call) => call.path.endsWith("/device/start"));
}

describe("device sign-in render contract", () => {
  it("mounts at all", async () => {
    // The assertion this file is really for: before it, nothing had ever
    // rendered this screen.
    routeParams.__setSearchParamsForTests(null);
    await render(<DeviceSignIn />, { wrapper });
    expect(screen.getByText("Sign in with another device")).toBeTruthy();
    expect(screen.getByTestId("device-signin-start")).toBeTruthy();
  });

  it("names the server this phone is about to be signed in against", async () => {
    // The origin is the whole security claim of the flow: the QR is approved on
    // another device, but the session is minted here, against this URL. The
    // collapsed row is the only place it appears.
    //
    // The origin has to be VOUCHED to be shown — see the next test for why —
    // so this one deposits the in-app hand-off the way the "use another device"
    // button does before rendering.
    depositInAppOrigin(API_BASE_URL);
    await render(<DeviceSignIn />, { wrapper });
    expect(screen.getByText(`Connecting to ${API_BASE_URL}`)).toBeTruthy();
  });

  it("refuses an origin a deep link merely NAMED", async () => {
    // This screen is reachable by system URL
    // (`moosewave://device-sign-in?base_url=...`), and it is reachable while
    // SIGNED OUT. Adopting whatever the parameter says would let anyone who can
    // get a link in front of a user mint that user's session against a server
    // of their choosing — and the flow then remembers the address, so it
    // survives into the password form afterwards.
    //
    // A valid URL is not a trusted one. With nothing vouching for it — no
    // in-app hand-off, no remembered address, no saved profile — the parameter
    // must be ignored, and the screen must fall back to the default rather than
    // silently honouring it.
    clearInAppOrigin();
    await AsyncStorage.clear();
    routeParams.__setSearchParamsForTests({
      base_url: "https://attacker.example.test",
    });

    await render(<DeviceSignIn />, { wrapper });

    expect(
      screen.queryByText("Connecting to https://attacker.example.test"),
    ).toBeNull();
    expect(
      screen.getByText(`Connecting to ${DEFAULT_API_BASE_URL}`),
    ).toBeTruthy();
  });

  it("still honours the hand-off from inside the app", async () => {
    // The vouch is one-shot and lives in process memory, which a deep link
    // cannot write to. Losing this would break first-time self-hosted setup,
    // where the user has typed an address the device has never stored.
    clearInAppOrigin();
    await AsyncStorage.clear();
    routeParams.__setSearchParamsForTests({ base_url: SELF_HOSTED_BASE_URL });
    depositInAppOrigin(SELF_HOSTED_BASE_URL);

    await render(<DeviceSignIn />, { wrapper });

    expect(
      screen.getByText(`Connecting to ${SELF_HOSTED_BASE_URL}`),
    ).toBeTruthy();
  });

  it("uses the remembered self-hosted server, not the SaaS default", async () => {
    // A cold open has no `base_url` param, so the screen reads the one the
    // device stored. Falling back to the build-time default here would show
    // the operator one server and post their device grant to another.
    routeParams.__setSearchParamsForTests(null);
    await AsyncStorage.setItem(LAST_BASE_URL_KEY, SELF_HOSTED_BASE_URL);
    await render(<DeviceSignIn />, { wrapper });

    expect(
      await screen.findByText(`Connecting to ${SELF_HOSTED_BASE_URL}`),
    ).toBeTruthy();
    await pressStart();
    expect(startCall()?.baseUrl).toBe(SELF_HOSTED_BASE_URL);
  });

  it("requests the session lifetime it just promised", async () => {
    // The switch's two sentences are a promise about how long the credential
    // lives. A screen that says "persistent" and asks for the 12-hour session
    // (or the reverse) is lying about exactly the thing the switch is for.
    mockWire.start = { data: grantBody({ remember: true }) };
    await render(<DeviceSignIn />, { wrapper });
    expect(
      screen.getByText(/expires server-side within 12 hours/u),
    ).toBeTruthy();

    await act(async () => {
      fireEvent(
        screen.getByLabelText("Keep me signed in on this phone"),
        "valueChange",
        true,
      );
    });
    expect(screen.getByText(/Request a persistent session/u)).toBeTruthy();

    await pressStart();
    expect(startCall()?.body.remember).toBe(true);
    // And the promise survives the phase change: the waiting screen is where
    // the user actually decides whether to approve.
    expect(
      await screen.findByText(/persistent session on this phone/u),
    ).toBeTruthy();
    expect(screen.queryByText(/session of up to 12 hours/u)).toBeNull();
  });

  it("shows the short matching code and never the device_code secret", async () => {
    // `device_code` is a bearer credential. This screen is designed to be held
    // up to a room, so a leak into a label, the QR payload or an accessibility
    // string is a handed-over session, not a cosmetic bug.
    await render(<DeviceSignIn />, { wrapper });
    await pressStart();

    expect(await screen.findByText("MATCHING CODE")).toBeTruthy();
    expect(screen.getByText(USER_CODE)).toBeTruthy();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).not.toContain(DEVICE_CODE);
    // An empty <Svg> satisfies getByLabelText and locks the user out just as
    // thoroughly as a crash, so assert the matrix produced real geometry.
    expect(
      screen.getByLabelText("QR code to approve this phone sign-in"),
    ).toBeTruthy();
    expect(tree).toContain("Path");
    // The no-camera path has to name a URL somebody can type.
    expect(screen.getByText(/app\.postwave\.com\/cli\/auth/u)).toBeTruthy();
  });

  it("does not put a matching code on screen when no grant was issued", async () => {
    // The damaging lie for this screen: a code and "Waiting for approval" after
    // a request that never reached the server. The user waits for something no
    // device can approve, and the real reason is one collapsed branch away.
    mockWire.start = {
      error: { kind: "network", message: "Network request failed" },
    };
    await render(<DeviceSignIn />, { wrapper });
    await pressStart();

    expect(await screen.findByText("Device sign-in unavailable")).toBeTruthy();
    expect(screen.getByText(/could not connect/u)).toBeTruthy();
    expect(screen.queryByText("MATCHING CODE")).toBeNull();
    expect(screen.queryByText("Waiting for approval")).toBeNull();
    // React Native's raw fetch string is not an instruction to anybody.
    expect(screen.queryByText(/Network request failed/u)).toBeNull();
    expect(screen.getByText("Get a new code")).toBeTruthy();
  });

  it("lands on the error view when the grant body is incomplete", async () => {
    // A partial 200 — `omitempty` on the server, or a hostile proxy. The costly
    // outcome is not a crash: it is a QR screen with a blank code and a blank
    // link, which reads as "keep waiting".
    mockWire.start = {
      data: { grant_kind: "session", remember: false, user_code: USER_CODE },
    };
    await render(<DeviceSignIn />, { wrapper });
    await pressStart();

    expect(await screen.findByText("Device sign-in unavailable")).toBeTruthy();
    expect(
      screen.getByText(/incomplete device sign-in request/u),
    ).toBeTruthy();
    expect(screen.queryByText("MATCHING CODE")).toBeNull();
    expect(screen.queryByText(USER_CODE)).toBeNull();
  });

  it("does not throw when the server answers with a non-object body", async () => {
    // The MaintenanceBanner failure in its wire form: every field read on an
    // array is undefined. It must surface as the error view, not as a throw
    // out of a promise nobody is holding.
    mockWire.start = { data: [] };
    await render(<DeviceSignIn />, { wrapper });
    await pressStart();
    expect(await screen.findByText("Device sign-in unavailable")).toBeTruthy();
  });

  it("refuses to start against a URL the app rejects, and says why", async () => {
    // The config mock answers `ok` for everything, so this branch of the
    // screen's own `start()` is otherwise unreachable. Two failures it guards:
    // POSTing a device grant to an origin the app already refused, and a CTA
    // that silently does nothing because the message was never surfaced.
    jest
      .spyOn(config, "validateApiBaseUrl")
      .mockReturnValue({ ok: false, message: "API URL is required." });
    await render(<DeviceSignIn />, { wrapper });
    await pressStart();

    expect(screen.getByText("API URL is required.")).toBeTruthy();
    expect(startCall()).toBeUndefined();
    // The message names the API field, so the screen has to open it.
    expect(screen.getByLabelText("API base URL")).toBeTruthy();
  });

  it("revokes the code when the user backs out, instead of leaving it approvable", async () => {
    // "Cancel sign-in" is a promise too. Navigating away while the grant is
    // still live leaves a code on the server that anybody holding the QR can
    // still approve into a session on this phone.
    await render(<DeviceSignIn />, { wrapper });
    await pressStart();
    expect(await screen.findByText("MATCHING CODE")).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText("Cancel sign-in"));
    });

    const cancelCall = mockAuthCalls.find(
      (call) => call.body.action === "cancel",
    );
    expect(cancelCall?.body.device_code).toBe(DEVICE_CODE);
    expect(router.back).toHaveBeenCalled();
  });
});
