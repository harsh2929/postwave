/**
 * Multiple server connections on one device.
 *
 * What a policy unit test cannot reach, and this pins:
 *   - the device's LIVE server is adopted as the first connection, so the list
 *     never opens empty while the app is plainly signed in to something;
 *   - adding a second server persists it (and a duplicate address is refused
 *     in words, not by a silently disabled button);
 *   - switching is a real transition: the chosen server is remembered as the
 *     one sign-in opens against, the active pointer moves, and the app leaves
 *     for the sign-in route. Nothing about the old server is left on screen,
 *     because there is no screen left;
 *   - the connection the device is signed in to is listed, marked and NOT a
 *     button, and cannot be removed.
 *
 * The teardown itself (lib/signOutFlow → store/authCleanup) is exercised by
 * its own suites; what is asserted here is that this control commits it rather
 * than swapping a base URL under a live session.
 */
import { describe, expect, it, beforeEach } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React, { type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import { ConnectionProfilesCard } from "@/components/workspace/ConnectionProfilesCard";
import { CONNECTION_PROFILES_KEY } from "@/lib/connectionProfileStore";
import { LAST_BASE_URL_KEY } from "@/lib/authPrefs";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = require("./mocks/asyncStorage.cjs") as {
  clear: () => Promise<void>;
  getItem: (key: string) => Promise<string | null>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { router } = require("./mocks/expoRouter.cjs") as {
  router: { replace: { mock: { calls: unknown[][] } } };
};

/** The address the mocked auth store says this device is signed in to. */
const LIVE = "https://api.moosewave.com";
const OTHER = "https://stage.acme.test";

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

beforeEach(async () => {
  await storage.clear();
});

async function openSheet() {
  const view = await render(<ConnectionProfilesCard />, { wrapper });
  await waitFor(() =>
    expect(screen.getByLabelText("Server connections, 1 saved")).toBeTruthy(),
  );
  fireEvent.press(screen.getByLabelText("Server connections, 1 saved"));
  await waitFor(() => expect(screen.getByLabelText("Server API URL")).toBeTruthy());
  return view;
}

/**
 * Fills the two fields and presses Save.
 *
 * Each field edit is awaited before the next event: this environment does not
 * flush a state update synchronously inside fireEvent, so pressing Save in the
 * same tick submits the PREVIOUS form values — which is a property of the test
 * harness, not of the form.
 */
async function addConnection(url: string, name: string): Promise<void> {
  fireEvent.changeText(screen.getByLabelText("Server API URL"), url);
  await waitFor(() =>
    expect(screen.getByLabelText("Server API URL").props.value).toBe(url),
  );
  fireEvent.changeText(screen.getByLabelText("Connection name"), name);
  await waitFor(() =>
    expect(screen.getByLabelText("Connection name").props.value).toBe(name),
  );
  fireEvent.press(screen.getByLabelText("Save this connection"));
}

async function storedConnections(): Promise<{
  profiles: { name: string; baseUrl: string }[];
  activeId: string | null;
}> {
  const raw = await storage.getItem(CONNECTION_PROFILES_KEY);
  return JSON.parse(raw ?? '{"profiles":[],"activeId":null}');
}

describe("server connections", () => {
  it("adopts the live server as the first connection", async () => {
    await openSheet();
    expect(
      screen.getByLabelText("api.moosewave.com, api.moosewave.com. Current connection."),
    ).toBeTruthy();
    const stored = await storedConnections();
    expect(stored.profiles).toHaveLength(1);
    expect(stored.profiles[0]?.baseUrl).toBe(LIVE);
    expect(stored.activeId).not.toBeNull();
  });

  it("saves a second server, and refuses the same address twice in words", async () => {
    await openSheet();
    await addConnection(OTHER, "Acme staging");
    await waitFor(() =>
      expect(screen.getByLabelText("Switch to Acme staging, stage.acme.test")).toBeTruthy(),
    );
    expect((await storedConnections()).profiles).toHaveLength(2);

    await addConnection(`${OTHER}/`, "Another name");
    await waitFor(() =>
      expect(
        screen.getByText("That server is already saved as “Acme staging”."),
      ).toBeTruthy(),
    );
    // Refused, not silently added.
    expect((await storedConnections()).profiles).toHaveLength(2);
  });

  it("refuses an address the app's own URL policy rejects", async () => {
    await openSheet();
    await addConnection("http://staging.acme.test", "Plaintext");
    await waitFor(() =>
      expect(
        screen.getByText("HTTP is only supported for localhost development APIs."),
      ).toBeTruthy(),
    );
    expect((await storedConnections()).profiles).toHaveLength(1);
  });

  it("switching signs out and opens sign-in pointed at the chosen server", async () => {
    await openSheet();
    await addConnection(OTHER, "Acme staging");
    const row = await screen.findByLabelText(
      "Switch to Acme staging, stage.acme.test",
    );
    fireEvent.press(row);
    // The confirmation names the whole transaction before anything happens.
    await waitFor(() =>
      expect(screen.getByText("Switch to Acme staging?")).toBeTruthy(),
    );
    expect(
      screen.getByText(/signs out of the current server/),
    ).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Sign out and switch"));

    await waitFor(async () =>
      expect(await storage.getItem(LAST_BASE_URL_KEY)).toBe(OTHER),
    );
    const stored = await storedConnections();
    const target = stored.profiles.find((p) => p.baseUrl === OTHER) as {
      baseUrl: string;
    } & { id?: string };
    expect(stored.activeId).toBe((target as { id?: string }).id);
    await waitFor(() =>
      expect(
        router.replace.mock.calls.some((call) => call[0] === "/(auth)/sign-in"),
      ).toBe(true),
    );
  });

  it("will not remove the connection this device is signed in to", async () => {
    await openSheet();
    // The current row is a plain View: there is no switch button and no remove
    // button for it, which is the refusal — the UI never offers the tap.
    expect(screen.queryByLabelText("Remove api.moosewave.com")).toBeNull();
    expect(
      screen.queryByLabelText("Switch to api.moosewave.com, api.moosewave.com"),
    ).toBeNull();
  });

  it("removes a saved connection after a confirmation", async () => {
    await openSheet();
    await addConnection(OTHER, "Acme staging");
    const remove = await screen.findByLabelText("Remove Acme staging");
    fireEvent.press(remove);
    await waitFor(() =>
      expect(screen.getByText("Remove Acme staging?")).toBeTruthy(),
    );
    fireEvent.press(screen.getByLabelText("Remove"));
    await waitFor(async () =>
      expect((await storedConnections()).profiles).toHaveLength(1),
    );
  });
});
