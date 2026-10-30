/**
 * Search — creation verbs and Settings sections reach their targets.
 *
 * Two desktop palette sources mobile lacked: "New campaign / form / list", and
 * one row per Settings section. Both carry PARAMS (`?new=1`, `?anchor=`), and
 * the screen used to open every palette row with `router.push(item.route)`,
 * which would have dropped them on the floor — the verb would land on the bare
 * list and read as having done nothing. So the assertions here are about the
 * href the tap produces, not merely that a row rendered.
 *
 * The role cases pin the gate at the SCREEN level: the catalogue tests pin the
 * rule, this pins that the screen actually feeds it the gate's role and mode.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import * as ExpoRouter from "expo-router";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as GateHooks from "@/hooks/useOnlineQueryGate";
import * as AuthStore from "@/store/auth";

import SearchScreen from "../app/(tabs)/search";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = GateHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};
const routerMock = ExpoRouter.router as unknown as { push: jest.Mock };

afterEach(async () => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
  // The storage mock keeps MODULE state: a row pressed in one test would
  // otherwise come back as a "Jump back in" recent in the next.
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

/** A settled, EMPTY server search, so only the local catalogue is on screen. */
function settled() {
  return {
    data: { hits: [], partial: false, truncated: false },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

async function typeQuery(text: string) {
  // useDebounced is identity in the route harness, so one change is enough.
  await fireEvent.changeText(screen.getByLabelText("Search Moosewave"), text);
}

describe("creation verbs", () => {
  it("offers New campaign to a writer and routes it with the create flag", async () => {
    queryHarness.__setQueryResultForTests(settled());
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });

    await render(<SearchScreen />, { wrapper });
    await typeQuery("new camp");

    // The badge is part of the spoken label: "New campaign. New".
    await fireEvent.press(screen.getByLabelText("New campaign. New"));

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: "/(tabs)/campaigns",
      params: { new: "1" },
    });
  });

  it("routes New list and New form to their own screens with the same flag", async () => {
    queryHarness.__setQueryResultForTests(settled());
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });

    await render(<SearchScreen />, { wrapper });

    await typeQuery("new list");
    await fireEvent.press(screen.getByLabelText("New list. New"));
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: "/(tabs)/lists",
      params: { new: "1" },
    });

    await typeQuery("new form");
    await fireEvent.press(screen.getByLabelText("New form. New"));
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: "/(tabs)/forms",
      params: { new: "1" },
    });
  });

  it("withholds every creation verb from a viewer", async () => {
    queryHarness.__setQueryResultForTests(settled());
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });

    await render(<SearchScreen />, { wrapper });
    await typeQuery("new");

    expect(screen.queryByText("New campaign")).toBeNull();
    expect(screen.queryByText("New list")).toBeNull();
    expect(screen.queryByText("New form")).toBeNull();
  });

  it("withholds the editor-floor verbs in api-key mode but keeps New campaign, as the screens do", async () => {
    queryHarness.__setQueryResultForTests(settled());
    authHarness.__setAuthStateForTests({ mode: "api_key" });

    await render(<SearchScreen />, { wrapper });
    await typeQuery("new");

    expect(screen.getByText("New campaign")).toBeTruthy();
    expect(screen.queryByText("New list")).toBeNull();
    expect(screen.queryByText("New form")).toBeNull();
  });

  it("withholds every creation verb without a usable online session", async () => {
    queryHarness.__setQueryResultForTests(settled());
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner", enabled: false });

    await render(<SearchScreen />, { wrapper });
    await typeQuery("new");

    expect(screen.queryByText("New campaign")).toBeNull();
  });
});

describe("settings sections", () => {
  it("routes a section to Settings with its anchor", async () => {
    queryHarness.__setQueryResultForTests(settled());

    await render(<SearchScreen />, { wrapper });
    await typeQuery("app lock");

    await fireEvent.press(screen.getByLabelText("App lock. Settings"));

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: "/(tabs)/settings",
      params: { anchor: "app-lock" },
    });
  });

  it("answers 'passkey' — the query the register says returned nothing", async () => {
    queryHarness.__setQueryResultForTests(settled());

    await render(<SearchScreen />, { wrapper });
    await typeQuery("passkey");

    expect(screen.getByText("Two-factor and devices")).toBeTruthy();
    expect(screen.getByText("Settings · Account")).toBeTruthy();
  });

  it("keeps the empty list a launcher — no sections or verbs until typed, except one just used", async () => {
    queryHarness.__setQueryResultForTests(settled());
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });

    await render(<SearchScreen />, { wrapper });

    expect(screen.queryByText("App lock")).toBeNull();
    expect(screen.queryByText("New campaign")).toBeNull();

    await typeQuery("app lock");
    await fireEvent.press(screen.getByLabelText("App lock. Settings"));
    await typeQuery("");

    // The section the operator just opened comes back as a recent — the
    // one way a section or verb earns a place in the empty list.
    expect(await screen.findByText("App lock")).toBeTruthy();
    expect(screen.queryByText("New campaign")).toBeNull();
  });
});
