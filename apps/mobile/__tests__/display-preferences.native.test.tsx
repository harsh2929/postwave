/**
 * Display preferences, the launch landing, and the web handoff — the render
 * contracts for LOVE#51 and LOVE#50.
 *
 * Three things here are worth more than a smoke test, because each of them
 * fails SILENTLY if it regresses:
 *
 *  - THE LANDING REDIRECT IS THE LAUNCH PATH. `app/index.tsx` is the first
 *    component the app renders after the splash gate lets go. A change that
 *    left it holding forever, or that redirected twice, would look like a slow
 *    phone rather than a bug — so the hold, the bound on the hold, and the
 *    "exactly one navigation" property are all asserted.
 *  - THE ROLE RE-CHECK IS A 403 THE USER WOULD OTHERWISE MEET AT LAUNCH.
 *    `GET /api/v1/approvals` calls `requireAdmin`
 *    (apps/api/internal/approvals/handlers.go:226 → :597, owner|admin only).
 *    A stored "open on Approvals" from before a demotion has to fall back.
 *  - THE HANDOFF IS THE ONLY WAY OFF A READ-ONLY DETAIL SCREEN. If it stops
 *    rendering, the screen silently becomes the dead end it used to be.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import AsyncStorage from "@react-native-async-storage/async-storage";

import * as AuthStore from "@/store/auth";
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { DisplayPreferencesSection } from "@/components/settings/DisplayPreferencesSection";
import { WebHandoffRow } from "@/components/WebHandoffRow";
import { appliedRowDensity, resetRowDensityStore } from "@/lib/rowDensityStore";

import Index from "../app/index";

const ROUTE_ID = "11111111-1111-4111-8111-111111111111";
const BASE_URL = "https://api.moosewave.com";
const USER_ID = "22222222-2222-4222-8222-222222222222";
/** The exact key lib/listPreferences writes under, for this identity. */
const PREF_KEY = `postwave.listprefs.v1:${BASE_URL}:${ROUTE_ID}:${USER_ID}:display`;

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

/** An identity complete enough for `preferenceKey` to produce a key at all. */
function identifiedGate(extra: Record<string, unknown> = {}) {
  gateHarness.__setOnlineGateForTests({
    baseUrl: BASE_URL,
    tenantId: ROUTE_ID,
    userId: USER_ID,
    ...extra,
  });
}

afterEach(async () => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
  resetRowDensityStore();
  await AsyncStorage.clear();
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

function redirectTarget(): string {
  return screen.getByTestId("mock-redirect").props.children as string;
}

describe("launch landing", () => {
  it("lands on Dashboard when nothing has been chosen", async () => {
    identifiedGate();
    await render(<Index />, { wrapper });
    expect(redirectTarget()).toBe("/(tabs)/dashboard");
  });

  it("honours a stored landing screen", async () => {
    identifiedGate();
    await AsyncStorage.setItem(
      PREF_KEY,
      JSON.stringify({ landing: "/(tabs)/approvals" }),
    );
    await render(<Index />, { wrapper });
    // Exactly ONE redirect element: a second would mean the screen navigated
    // to Dashboard first and then again, which flashes the wrong tab and
    // leaves a bogus entry behind it.
    expect(screen.getAllByTestId("mock-redirect")).toHaveLength(1);
    expect(redirectTarget()).toBe("/(tabs)/approvals");
  });

  it("falls back to Dashboard when the role can no longer reach the choice", async () => {
    // requireAdmin admits owner|admin only. An editor who was an admin when
    // they chose this must not open the app on a guaranteed 403.
    authHarness.__setAuthStateForTests({
      session: { effectiveRole: "editor", role: "editor" },
    });
    identifiedGate();
    await AsyncStorage.setItem(
      PREF_KEY,
      JSON.stringify({ landing: "/(tabs)/approvals" }),
    );
    await render(<Index />, { wrapper });
    expect(redirectTarget()).toBe("/(tabs)/dashboard");
  });

  it("ignores a landing route written by an older build", async () => {
    identifiedGate();
    await AsyncStorage.setItem(
      PREF_KEY,
      JSON.stringify({ landing: "/(tabs)/flows" }),
    );
    await render(<Index />, { wrapper });
    expect(redirectTarget()).toBe("/(tabs)/dashboard");
  });

  it("sends a signed-out user to sign-in without waiting on the preference", async () => {
    // The hold must sit BELOW the auth branch: someone who is signed out has
    // to reach the screen they can act from, whatever the disk is doing.
    authHarness.__setAuthStateForTests({ canEnterApp: () => false });
    identifiedGate();
    await render(<Index />, { wrapper });
    expect(redirectTarget()).toBe("/(auth)/sign-in");
  });
});

describe("display preferences section", () => {
  it("offers theme, density and landing — not theme alone", async () => {
    identifiedGate();
    await render(<DisplayPreferencesSection />, { wrapper });
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(screen.getByText("List density")).toBeTruthy();
    expect(screen.getByText("Open the app on")).toBeTruthy();
    expect(screen.getByText("Comfortable")).toBeTruthy();
    expect(screen.getByText("Compact")).toBeTruthy();
  });

  it("names what a landing chip DOES in the spoken label", async () => {
    // The visible chip is one word; on its own it does not say that tapping
    // it changes where the app opens.
    identifiedGate();
    await render(<DisplayPreferencesSection />, { wrapper });
    expect(screen.getByLabelText("Open the app on Home")).toBeTruthy();
  });

  it("hides the Approvals landing choice from a role the handler would 403", async () => {
    authHarness.__setAuthStateForTests({
      session: { effectiveRole: "editor", role: "editor" },
    });
    identifiedGate();
    await render(<DisplayPreferencesSection />, { wrapper });
    expect(screen.queryByLabelText("Open the app on Approve")).toBeNull();
    expect(screen.getByLabelText("Open the app on Home")).toBeTruthy();
  });

  it("publishes the density so list rows can read it, in both directions", async () => {
    // The store is what SubscriberRow and CampaignListRow consume; a control
    // that only wrote to disk would change nothing until the next launch.
    identifiedGate();
    await AsyncStorage.setItem(PREF_KEY, JSON.stringify({ density: "compact" }));
    await render(<DisplayPreferencesSection />, { wrapper });
    await waitFor(() => expect(appliedRowDensity()).toBe("compact"));
    fireEvent.press(screen.getByText("Comfortable"));
    await waitFor(() => expect(appliedRowDensity()).toBe("comfortable"));
  });

  it("keeps a tap made while the disk read was still in flight", async () => {
    // Regression test for a real defect in useListPreferences: the read is
    // issued on mount, and a control tapped before it lands used to be
    // overwritten a tick later by whatever was on disk BEFORE the write. The
    // window is narrow but it is exactly the window a preference control is
    // tapped in, and the symptom — a chip that flicks back on its own — is
    // indistinguishable from a broken control.
    identifiedGate();
    // Hold the disk read open so the tap lands strictly inside its window.
    let releaseRead = (): void => {};
    jest
      .spyOn(AsyncStorage, "getItem")
      .mockImplementation(
        (key: string) =>
          new Promise<string | null>((resolve) => {
            releaseRead = () =>
              resolve(
                key === PREF_KEY
                  ? JSON.stringify({ density: "comfortable" })
                  : null,
              );
          }),
      );

    await render(<DisplayPreferencesSection />, { wrapper });
    fireEvent.press(screen.getByText("Compact"));
    // Now let the STALE snapshot — written before the tap — come back.
    releaseRead();

    await waitFor(() => expect(appliedRowDensity()).toBe("compact"));
  });

  it("reports the density selection to telemetry as a fixed token", async () => {
    const onChange = jest.fn();
    identifiedGate();
    await render(<DisplayPreferencesSection onChange={onChange} />, { wrapper });
    fireEvent.press(screen.getByText("Compact"));
    expect(onChange).toHaveBeenCalledWith("row_density", "compact");
  });

  it("explains the control that is deliberately absent", async () => {
    // A missing affordance with no explanation reads as an oversight. This is
    // the one place the product says why tab order is fixed and points at the
    // thing that does solve the need.
    identifiedGate();
    await render(<DisplayPreferencesSection />, { wrapper });
    expect(screen.getByText("Tab bar order")).toBeTruthy();
    expect(screen.getByText(/Pin your own destinations/)).toBeTruthy();
  });
});

describe("web handoff on a read-only detail screen", () => {
  /**
   * The sequence screen renders the handoff inside StepCanvas's `footer`,
   * alongside the participants and stuck sections — the only scroller on that
   * screen, and where every other supplementary section already lives. In THIS
   * harness StepCanvas is replaced by a null component
   * (jest.routes.config.cjs stubs `@/components/sequence-builder/*` apart from
   * the pure codec), so its footer is never rendered and a route-level
   * assertion there would be a test of the stub.
   *
   * So the sequence entity is pinned at the component contract instead, with
   * exactly the props app/(tabs)/sequences/[id].tsx passes; the wiring itself
   * is a compile-time obligation (the prop union is a literal type). The
   * end-to-end assertion lives on the campaign detail, whose content component
   * resolves for real — see campaign-detail.native.test.tsx.
   */
  it("offers a way off the sequence screen, with copy as the primary action", async () => {
    await render(
      <WebHandoffRow entity="sequence" id={ROUTE_ID} label="Welcome journey" />,
      { wrapper },
    );

    // Copy leads: the in-app browser does not carry this app's session, so
    // "Open" can legitimately land on the web sign-in while pasting the link
    // where the user is already signed in always works.
    expect(
      screen.getByLabelText("Copy the dashboard link for Welcome journey"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Open Welcome journey in the Moosewave dashboard"),
    ).toBeTruthy();
    // And it says the link may ask for a sign-in rather than letting the user
    // find that out after a tap.
    expect(screen.getByText(/You may need to sign in there/)).toBeTruthy();
  });

  it("renders NOTHING rather than a dead control when the id is unusable", async () => {
    // A disabled handoff explains nothing useful; an unsafe id must never be
    // pasted into a URL at all (lib/webHandoff).
    await render(
      <WebHandoffRow entity="sequence" id="../../admin" label="Bad" />,
      { wrapper },
    );
    expect(screen.queryByText(/You may need to sign in there/)).toBeNull();
  });
});
