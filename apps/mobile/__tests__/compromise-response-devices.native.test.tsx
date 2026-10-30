/**
 * Compromise response — the two revocation lists, PRESSED.
 *
 * A control-coverage audit found ActiveDevicesSection and TrustedDevicesSection
 * mounted and rendered by the Settings smoke tests, but not one of their four
 * destructive controls had ever been pressed. Rendering a "Sign out all other
 * devices" button proves the button exists; it proves nothing about what the
 * button DOES, and this is the screen an operator reaches for while a laptop is
 * missing.
 *
 * What is pinned here, per control:
 *
 *  1. THE GUARD. Every one of the four verbs must raise the ConfirmSheet, and
 *     the sheet's copy must name the consequence in the words the operator
 *     needs (which device, how many, and — for trusted devices — that THIS
 *     phone is included). Dismissing it must issue nothing at all.
 *  2. THE ACTION. Confirming must call the mutation with THAT row's id (a
 *     bulk verb: exactly once), and the success sentence must report the
 *     SERVER's count, pluralised, rather than the client's optimistic guess.
 *  3. THE FAILURE. A rejected mutation must surface the server's own message
 *     rather than a generic one, and must not claim success.
 *  4. THE ASYMMETRY THE TWO LISTS EXIST TO TEACH. The current SESSION cannot
 *     be revoked from the sessions list (mixing it with "sign out" strands the
 *     user), while the current TRUSTED DEVICE can and must be forgettable —
 *     forgetting it is the whole point of the screen after a compromise.
 *
 * The hooks are mocked at the module boundary so the assertions are about what
 * this UI ISSUES; the transport is pinned by api/authSessions + api/trustedDevices.
 * Everything above that boundary — the confirm gate, the pending state, the
 * pluralisation, the toast copy — is the real component running.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import { ActiveDevicesSection } from "@/components/settings/ActiveDevicesSection";
import { TrustedDevicesSection } from "@/components/settings/TrustedDevicesSection";

const HOUR = 3_600_000;
const DAY = 86_400_000;

type QueryLike = Record<string, unknown>;

/** Everything the mocked session hooks answer with, and everything they saw. */
const mockSessionsState: {
  query: QueryLike;
  revokeCalls: string[];
  revokeReject: Error | null;
  revokePending: boolean;
  logoutAllCalls: number;
  logoutAllCount: number;
  logoutAllReject: Error | null;
  logoutAllPending: boolean;
} = {
  query: {},
  revokeCalls: [],
  revokeReject: null,
  revokePending: false,
  logoutAllCalls: 0,
  logoutAllCount: 2,
  logoutAllReject: null,
  logoutAllPending: false,
};

/** The same, for the trusted-device hooks. */
const mockTrustedState: {
  query: QueryLike;
  forgetCalls: string[];
  forgetReject: Error | null;
  forgetPending: boolean;
  forgetAllCalls: number;
  forgetAllCount: number;
  forgetAllReject: Error | null;
  forgetAllPending: boolean;
} = {
  query: {},
  forgetCalls: [],
  forgetReject: null,
  forgetPending: false,
  forgetAllCalls: 0,
  forgetAllCount: 2,
  forgetAllReject: null,
  forgetAllPending: false,
};

jest.mock("@/hooks/useSessions", () => ({
  useSessions: () => mockSessionsState.query,
  useRevokeSession: () => ({
    get isPending() {
      return mockSessionsState.revokePending;
    },
    mutateAsync: async (id: string) => {
      mockSessionsState.revokeCalls.push(id);
      if (mockSessionsState.revokeReject) throw mockSessionsState.revokeReject;
      return undefined;
    },
  }),
  useLogoutOtherSessions: () => ({
    get isPending() {
      return mockSessionsState.logoutAllPending;
    },
    mutateAsync: async () => {
      mockSessionsState.logoutAllCalls += 1;
      if (mockSessionsState.logoutAllReject) {
        throw mockSessionsState.logoutAllReject;
      }
      return mockSessionsState.logoutAllCount;
    },
  }),
}));

jest.mock("@/hooks/useTrustedDevices", () => ({
  useTrustedDevices: () => mockTrustedState.query,
  useRevokeTrustedDevice: () => ({
    get isPending() {
      return mockTrustedState.forgetPending;
    },
    mutateAsync: async (id: string) => {
      mockTrustedState.forgetCalls.push(id);
      if (mockTrustedState.forgetReject) throw mockTrustedState.forgetReject;
      return undefined;
    },
  }),
  useRevokeAllTrustedDevices: () => ({
    get isPending() {
      return mockTrustedState.forgetAllPending;
    },
    mutateAsync: async () => {
      mockTrustedState.forgetAllCalls += 1;
      if (mockTrustedState.forgetAllReject) {
        throw mockTrustedState.forgetAllReject;
      }
      return mockTrustedState.forgetAllCount;
    },
  }),
}));

function loaded(data: unknown): QueryLike {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isFetching: false,
    isSuccess: true,
    refetch: async () => ({ data }),
  };
}

/** The shape `GET /api/v1/auth/sessions` returns, already sorted. */
function sessionRows(now: number) {
  return [
    {
      id: "s-current",
      issued_at: new Date(now - 2 * DAY).toISOString(),
      last_seen_at: new Date(now).toISOString(),
      expires_at: new Date(now + 30 * DAY).toISOString(),
      device_label: "iPhone 15 Pro",
      auth_method: "password",
      current: true,
    },
    {
      id: "s-laptop",
      issued_at: new Date(now - 3 * DAY).toISOString(),
      last_seen_at: new Date(now - 2 * HOUR).toISOString(),
      expires_at: new Date(now + 20 * DAY).toISOString(),
      device_label: "MacBook Pro",
      auth_method: "password",
      current: false,
    },
    {
      id: "s-cli",
      issued_at: new Date(now - 9 * DAY).toISOString(),
      last_seen_at: new Date(now - 3 * DAY).toISOString(),
      expires_at: new Date(now + 10 * DAY).toISOString(),
      device_label: "Moosewave CLI",
      auth_method: "cli",
      current: false,
    },
  ];
}

/** The shape `GET /api/v1/auth/trusted-devices` returns. */
function trustedPolicy(now: number) {
  return {
    allowed: true,
    allowedDurations: [30, 90, 180],
    devices: [
      {
        id: "td-this-phone",
        trust_days: 30,
        issued_at: new Date(now - 2 * DAY).toISOString(),
        expires_at: new Date(now + 28 * DAY).toISOString(),
        last_used_at: new Date(now - 1 * DAY).toISOString(),
        label: "iPhone 15 Pro",
        current: true,
      },
      {
        id: "td-laptop",
        trust_days: 90,
        issued_at: new Date(now - 78 * DAY).toISOString(),
        expires_at: new Date(now + 12 * DAY + HOUR).toISOString(),
        label: "MacBook Pro",
        current: false,
      },
    ],
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

/**
 * Press, then let the awaited `confirm(...)` promise and everything after it
 * settle. The handlers here are `async` all the way down — the confirm resolves
 * on a microtask, the mutation on another — so a bare fireEvent leaves the
 * assertions looking at the state BEFORE the action ran.
 */
async function press(element: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(element);
  });
}

beforeEach(() => {
  const now = Date.now();
  mockSessionsState.query = loaded(sessionRows(now));
  mockSessionsState.revokeCalls = [];
  mockSessionsState.revokeReject = null;
  mockSessionsState.revokePending = false;
  mockSessionsState.logoutAllCalls = 0;
  mockSessionsState.logoutAllCount = 2;
  mockSessionsState.logoutAllReject = null;
  mockSessionsState.logoutAllPending = false;

  mockTrustedState.query = loaded(trustedPolicy(now));
  mockTrustedState.forgetCalls = [];
  mockTrustedState.forgetReject = null;
  mockTrustedState.forgetPending = false;
  mockTrustedState.forgetAllCalls = 0;
  mockTrustedState.forgetAllCount = 2;
  mockTrustedState.forgetAllReject = null;
  mockTrustedState.forgetAllPending = false;
});

afterEach(() => {
  mockSessionsState.query = {};
  mockTrustedState.query = {};
});

describe("ActiveDevicesSection — per-device revoke", () => {
  it("raises a confirm naming THAT device and the irreversibility, and dismissing revokes nothing", async () => {
    await render(<ActiveDevicesSection />, { wrapper });

    await press(screen.getByLabelText(/^Sign out MacBook Pro, last active/u));

    // The guard, in the operator's words.
    expect(screen.getByText("Sign out MacBook Pro?")).toBeTruthy();
    expect(
      screen.getByText(
        "That device will need to sign in again. This cannot be undone from here.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Last active 2 hours ago.")).toBeTruthy();

    await press(screen.getByLabelText("Cancel"));

    // Dismissal performs NOTHING, and the sheet is gone.
    expect(mockSessionsState.revokeCalls).toEqual([]);
    expect(screen.queryByText("Sign out MacBook Pro?")).toBeNull();
  });

  it("dismissing by the backdrop also revokes nothing", async () => {
    await render(<ActiveDevicesSection />, { wrapper });

    await press(screen.getByLabelText(/^Sign out MacBook Pro, last active/u));
    await press(screen.getByLabelText("Dismiss"));

    expect(mockSessionsState.revokeCalls).toEqual([]);
    expect(screen.queryByText("Sign out MacBook Pro?")).toBeNull();
  });

  it("confirming revokes THAT row's id — not the first row's — and says so", async () => {
    await render(<ActiveDevicesSection />, { wrapper });

    await press(screen.getByLabelText(/^Sign out Moosewave CLI, last active/u));
    await press(screen.getByLabelText("Sign out"));

    // The id is the load-bearing argument: revoking the wrong session on this
    // screen signs out a device the operator meant to keep.
    expect(mockSessionsState.revokeCalls).toEqual(["s-cli"]);
    expect(screen.getByText("Moosewave CLI signed out.")).toBeTruthy();
  });

  it("surfaces the server's own message when a revoke fails, and claims no success", async () => {
    mockSessionsState.revokeReject = new Error(
      "That device was already signed out.",
    );
    await render(<ActiveDevicesSection />, { wrapper });

    await press(screen.getByLabelText(/^Sign out MacBook Pro, last active/u));
    await press(screen.getByLabelText("Sign out"));

    expect(mockSessionsState.revokeCalls).toEqual(["s-laptop"]);
    expect(screen.getByText("That device was already signed out.")).toBeTruthy();
    expect(screen.queryByText("MacBook Pro signed out.")).toBeNull();
  });

  it("names an unlabelled device rather than rendering an empty confirm title", async () => {
    mockSessionsState.query = loaded([
      {
        id: "s-anon",
        issued_at: new Date(Date.now() - DAY).toISOString(),
        last_seen_at: new Date(Date.now() - DAY).toISOString(),
        expires_at: new Date(Date.now() + DAY).toISOString(),
        auth_method: "password",
        current: false,
      },
    ]);
    await render(<ActiveDevicesSection />, { wrapper });

    await press(screen.getByLabelText(/^Sign out Unknown device, last active/u));
    expect(screen.getByText("Sign out Unknown device?")).toBeTruthy();
  });

  it("offers no revoke control on THIS device's row", async () => {
    await render(<ActiveDevicesSection />, { wrapper });

    // Signing this phone out is what the Sign out control on Settings is for;
    // a revoke here would be the one mis-tap that strands the operator.
    expect(screen.queryByLabelText(/^Sign out iPhone 15 Pro/u)).toBeNull();
    expect(screen.getByText("This device")).toBeTruthy();
  });
});

describe("ActiveDevicesSection — sign out every other device", () => {
  it("counts only the OTHER sessions, and dismissing signs nothing out", async () => {
    await render(<ActiveDevicesSection />, { wrapper });

    // Three rows, one of them this phone: the bulk verb must say two.
    await press(screen.getByLabelText("Sign out all 2 other devices"));

    expect(screen.getByText("Sign out every other device?")).toBeTruthy();
    expect(
      screen.getByText(
        "Every browser, CLI and phone except this one will need to sign in again.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("2 other sessions will end immediately.")).toBeTruthy();

    await press(screen.getByLabelText("Cancel"));
    expect(mockSessionsState.logoutAllCalls).toBe(0);
  });

  it("confirming calls logout-all exactly once and reports the SERVER's count", async () => {
    mockSessionsState.logoutAllCount = 5;
    await render(<ActiveDevicesSection />, { wrapper });

    await press(screen.getByLabelText("Sign out all 2 other devices"));
    await press(screen.getByLabelText("Sign out all"));

    expect(mockSessionsState.logoutAllCalls).toBe(1);
    // Five, not the two rows this client happened to be holding: the server
    // knows about sessions this list never paged in.
    expect(screen.getByText("Signed out 5 other devices.")).toBeTruthy();
  });

  it("says 'device', singular, when the server revoked exactly one", async () => {
    mockSessionsState.logoutAllCount = 1;
    await render(<ActiveDevicesSection />, { wrapper });

    await press(screen.getByLabelText("Sign out all 2 other devices"));
    await press(screen.getByLabelText("Sign out all"));

    expect(screen.getByText("Signed out 1 other device.")).toBeTruthy();
  });

  it("says 'session', singular, in the consequence when only one other exists", async () => {
    const now = Date.now();
    mockSessionsState.query = loaded(sessionRows(now).slice(0, 2));
    await render(<ActiveDevicesSection />, { wrapper });

    await press(screen.getByLabelText("Sign out all 1 other devices"));
    expect(screen.getByText("1 other session will end immediately.")).toBeTruthy();
  });

  it("does not offer the bulk verb when this phone is the only session", async () => {
    const now = Date.now();
    mockSessionsState.query = loaded(sessionRows(now).slice(0, 1));
    await render(<ActiveDevicesSection />, { wrapper });

    expect(screen.queryByLabelText(/^Sign out all/u)).toBeNull();
  });

  it("surfaces the server's message when logout-all fails", async () => {
    mockSessionsState.logoutAllReject = new Error("Session store unavailable.");
    await render(<ActiveDevicesSection />, { wrapper });

    await press(screen.getByLabelText("Sign out all 2 other devices"));
    await press(screen.getByLabelText("Sign out all"));

    expect(mockSessionsState.logoutAllCalls).toBe(1);
    expect(screen.getByText("Session store unavailable.")).toBeTruthy();
    expect(screen.queryByText(/^Signed out/u)).toBeNull();
  });
});

describe("TrustedDevicesSection — forget one", () => {
  it("raises a confirm naming the device, the MFA consequence and its expiry; dismissing forgets nothing", async () => {
    await render(<TrustedDevicesSection />, { wrapper });

    await press(screen.getByLabelText(/^Forget MacBook Pro\./u));

    expect(screen.getByText("Forget MacBook Pro?")).toBeTruthy();
    expect(
      screen.getByText(
        "It will ask for a two-factor code again the next time it signs in.",
      ),
    ).toBeTruthy();
    // The consequence is the row's own remaining trust window, so the operator
    // can see what they are giving up.
    expect(screen.getAllByText("Expires in 12 days").length).toBeGreaterThan(0);

    await press(screen.getByLabelText("Cancel"));
    expect(mockTrustedState.forgetCalls).toEqual([]);
  });

  it("confirming forgets THAT row's id and says the code will be asked for again", async () => {
    await render(<TrustedDevicesSection />, { wrapper });

    await press(screen.getByLabelText(/^Forget MacBook Pro\./u));
    await press(screen.getByLabelText("Forget"));

    expect(mockTrustedState.forgetCalls).toEqual(["td-laptop"]);
    expect(
      screen.getByText("MacBook Pro will ask for a code again."),
    ).toBeTruthy();
  });

  it("CAN forget THIS phone — the one revocation the sessions list refuses", async () => {
    await render(<TrustedDevicesSection />, { wrapper });

    // A trusted device is not a session: after a compromise, killing this
    // phone's MFA-skip credential is exactly what the operator came here for.
    await press(screen.getByLabelText(/^Forget iPhone 15 Pro\./u));
    await press(screen.getByLabelText("Forget"));

    expect(mockTrustedState.forgetCalls).toEqual(["td-this-phone"]);
  });

  it("surfaces the server's message when a forget fails", async () => {
    mockTrustedState.forgetReject = new Error(
      "That device was already forgotten.",
    );
    await render(<TrustedDevicesSection />, { wrapper });

    await press(screen.getByLabelText(/^Forget MacBook Pro\./u));
    await press(screen.getByLabelText("Forget"));

    expect(
      screen.getByText("That device was already forgotten."),
    ).toBeTruthy();
    expect(screen.queryByText(/will ask for a code again\.$/u)).toBeNull();
  });
});

describe("TrustedDevicesSection — forget all", () => {
  it("warns that THIS phone is included, and dismissing forgets nothing", async () => {
    await render(<TrustedDevicesSection />, { wrapper });

    await press(screen.getByLabelText("Forget all 2 remembered devices"));

    expect(screen.getByText("Ask for a code everywhere?")).toBeTruthy();
    // "including this phone" is the sentence that distinguishes this verb from
    // "sign out all other devices", which deliberately spares this device.
    expect(
      screen.getByText(
        "Every remembered device, including this phone, will need a two-factor code at its next sign-in.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("2 remembered devices will be forgotten immediately."),
    ).toBeTruthy();

    await press(screen.getByLabelText("Cancel"));
    expect(mockTrustedState.forgetAllCalls).toBe(0);
  });

  it("confirming revokes all once and reports the server's count", async () => {
    mockTrustedState.forgetAllCount = 4;
    await render(<TrustedDevicesSection />, { wrapper });

    await press(screen.getByLabelText("Forget all 2 remembered devices"));
    await press(screen.getByLabelText("Forget all"));

    expect(mockTrustedState.forgetAllCalls).toBe(1);
    expect(screen.getByText("Forgot 4 devices.")).toBeTruthy();
  });

  it("says 'device', singular, when the server forgot exactly one", async () => {
    mockTrustedState.forgetAllCount = 1;
    await render(<TrustedDevicesSection />, { wrapper });

    await press(screen.getByLabelText("Forget all 2 remembered devices"));
    await press(screen.getByLabelText("Forget all"));

    expect(screen.getByText("Forgot 1 device.")).toBeTruthy();
  });

  it("does not offer forget-all when nothing is remembered", async () => {
    mockTrustedState.query = loaded({
      allowed: true,
      allowedDurations: [30, 90, 180],
      devices: [],
    });
    await render(<TrustedDevicesSection />, { wrapper });

    expect(screen.queryByLabelText(/^Forget all/u)).toBeNull();
    expect(screen.getByText("No remembered devices")).toBeTruthy();
  });

  it("surfaces the server's message when forget-all fails", async () => {
    mockTrustedState.forgetAllReject = new Error("Trust store unavailable.");
    await render(<TrustedDevicesSection />, { wrapper });

    await press(screen.getByLabelText("Forget all 2 remembered devices"));
    await press(screen.getByLabelText("Forget all"));

    expect(mockTrustedState.forgetAllCalls).toBe(1);
    expect(screen.getByText("Trust store unavailable.")).toBeTruthy();
    expect(screen.queryByText(/^Forgot /u)).toBeNull();
  });
});
