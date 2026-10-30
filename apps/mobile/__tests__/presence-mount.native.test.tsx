/**
 * Presence is RENDERED BY A SCREEN (MOB-UNW-02 / AUD-2).
 *
 * The defect this pins is not a wrong pixel — it is a whole feature that was
 * subscribed, parsed, stored and unit-tested while no screen mounted the
 * component that shows it. `__tests__/presence-bar.native.test.tsx` renders
 * PresenceBar DIRECTLY, so it stayed green the entire time the app displayed
 * nothing; a component test can never notice that its component has no call
 * site.
 *
 * So this test starts from the SCREEN. It renders app/(tabs)/dashboard.tsx,
 * pushes a presence frame into the store the transport writes to, and asserts
 * the spoken sentence reaches the tree. Delete `<PresenceBar />` from the
 * dashboard and this goes red; nothing else in the suite would.
 *
 * It also pins the quiet case, which is the one that decides whether the
 * feature is tolerable to live with: alone in a workspace, the screen must say
 * nothing at all rather than carry a permanent "0 others" badge.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  applyWorkspacePresence,
  resetWorkspacePresence,
} from "@/lib/presenceStore";
import * as AuthStore from "@/store/auth";

jest.mock("@/hooks/useGoals", () => ({
  useGoalsProgress: () => ({ data: [], isLoading: false }),
}));
jest.mock("@/hooks/useDashboardAnomalies", () => ({
  useDashboardAnomalies: () => ({ data: [], isLoading: false }),
}));
jest.mock("@/hooks/useWidgetMirror", () => ({
  useWidgetMirror: () => undefined,
}));
jest.mock("@/components/onboarding/DashboardOnboarding", () => ({
  DashboardOnboarding: () => null,
}));

// eslint-disable-next-line import/first
import Dashboard from "../app/(tabs)/dashboard";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __resetQueryResultForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __resetAuthStateForTests: () => void;
};

/** The signed-in user id the default auth fixture reports. */
const SELF_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  authHarness.__resetAuthStateForTests();
  resetWorkspacePresence();
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

describe("presence is mounted by a screen", () => {
  it("shows who else is in the workspace on the dashboard", async () => {
    // Exactly what the transport writes: eventCacheSync routes a live
    // `presence.update` frame here, so this is the real seam, not a prop.
    applyWorkspacePresence({
      count: 2,
      users_v2: [
        { id: SELF_ID, label: "alice" },
        { id: "u2", label: "bob" },
      ],
    });

    await render(<Dashboard />, { wrapper });

    // The spoken sentence — the bubbles are never the only signal, and the
    // phone's own connection is excluded, so two connections read as one
    // other person.
    expect(screen.getByLabelText("bob in this workspace")).toBeTruthy();
    expect(
      screen.getByText("1 other here", { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it("says nothing at all when the reader is alone", async () => {
    await render(<Dashboard />, { wrapper });

    expect(
      screen.queryByText("1 other here", { includeHiddenElements: true }),
    ).toBeNull();
    expect(
      screen.queryByText("others here", {
        exact: false,
        includeHiddenElements: true,
      }),
    ).toBeNull();
  });

  it("does not render an identity the workspace payload did not name", async () => {
    // PRIVACY. The app now holds colleague identities in memory; the screen
    // must render the privacy-safe label the server sent (an email
    // LOCAL-PART) and never reconstruct an address from it.
    applyWorkspacePresence({
      count: 2,
      users_v2: [
        { id: SELF_ID, label: "alice" },
        { id: "u2", label: "bob@example.com" },
      ],
    });

    await render(<Dashboard />, { wrapper });

    expect(screen.getByLabelText("bob in this workspace")).toBeTruthy();
    expect(
      screen.queryByText(/bob@example\.com/u, { includeHiddenElements: true }),
    ).toBeNull();
    expect(
      screen.queryByLabelText(/bob@example\.com/u, {
        includeHiddenElements: true,
      }),
    ).toBeNull();
  });
});
