/**
 * SHELL#6 — the workspace switcher.
 *
 * What this pins is the part a policy unit test cannot reach: that the control
 * HIDES itself for the single-workspace majority, that the workspace the
 * device is already in is listed but not a button, and that tapping a sibling
 * runs the identity transition for that workspace and reports the outcome
 * rather than silently swapping tenants.
 *
 * The transition itself (`switchWorkspaceSession`) is mocked here on purpose:
 * it commits a real sign-in — wiping the vault, the query cache and the widget
 * container — and what this file is testing is the wiring in front of it.
 */
import { describe, expect, it, jest, beforeEach, afterEach } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ToastProvider } from "@/components/Toast";
import { WorkspaceSwitcher } from "@/components/workspace/WorkspaceSwitcher";

// `mock`-prefixed so babel-jest allows the factory below to close over it.
const mockSwitch = jest.fn<
  (id: string, name: string) => Promise<{ switched: boolean; workspaceName: string }>
>();

jest.mock("@/store/authWorkspaceSwitch", () => ({
  switchWorkspaceSession: (id: string, name: string) => mockSwitch(id, name),
}));

const {
  __setQueryResultForTests,
  __resetQueryResultForTests,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/reactQuery.cjs") as {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const CURRENT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme",
  role: "owner",
  current: true,
};
const SIBLING = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Beta Client",
  slug: "beta",
  role: "admin",
  current: false,
};

function loaded(rows: unknown[]) {
  __setQueryResultForTests({
    data: rows,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(),
  });
}

async function renderSwitcher() {
  return await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <WorkspaceSwitcher />
      </ToastProvider>
    </SafeAreaProvider>,
  );
}

/**
 * Press the trigger and wait for the sheet's Modal to commit. `fireEvent.press`
 * only schedules the state update; the rows do not exist until React has
 * flushed it, so asserting straight afterwards reads an empty tree.
 */
async function openSheet(): Promise<void> {
  fireEvent.press(screen.getByLabelText("Switch workspace, 1 other workspace"));
  await waitFor(() => expect(screen.getByText("Beta Client")).toBeTruthy());
}

describe("SHELL#6 — workspace switcher", () => {
  beforeEach(() => {
    mockSwitch.mockReset();
    mockSwitch.mockResolvedValue({
      switched: true,
      workspaceName: "Beta Client",
    });
  });
  afterEach(() => {
    __resetQueryResultForTests();
  });

  it("renders nothing while the workspace list is unknown", async () => {
    // Absence is not "one workspace": a failed list must not silently remove
    // the control for everyone whose request did not land.
    await renderSwitcher();
    expect(screen.queryByLabelText(/Switch workspace/)).toBeNull();
  });

  it("renders nothing for a single-workspace user", async () => {
    loaded([CURRENT]);
    await renderSwitcher();
    expect(screen.queryByLabelText(/Switch workspace/)).toBeNull();
  });

  it("offers the switcher, counting only the siblings", async () => {
    loaded([CURRENT, SIBLING]);
    await renderSwitcher();
    expect(
      screen.getByLabelText("Switch workspace, 1 other workspace"),
    ).toBeTruthy();
  });

  it("lists the current workspace without making it a switch target", async () => {
    loaded([CURRENT, SIBLING]);
    await renderSwitcher();
    await openSheet();

    expect(screen.getByLabelText("Acme. Current workspace.")).toBeTruthy();
    expect(screen.queryByLabelText("Switch to Acme")).toBeNull();
    expect(screen.getByLabelText("Switch to Beta Client")).toBeTruthy();
  });

  it("switches into the workspace that was tapped and says so", async () => {
    loaded([CURRENT, SIBLING]);
    await renderSwitcher();
    await openSheet();
    fireEvent.press(screen.getByLabelText("Switch to Beta Client"));

    await waitFor(() =>
      expect(mockSwitch).toHaveBeenCalledWith(
        SIBLING.id,
        "Beta Client",
      ),
    );
    expect(await screen.findByText("Switched to Beta Client.")).toBeTruthy();
  });

  it("reports a refused switch instead of claiming success", async () => {
    mockSwitch.mockRejectedValue(
      new Error("Your access to that workspace was removed."),
    );
    loaded([CURRENT, SIBLING]);
    await renderSwitcher();
    await openSheet();
    fireEvent.press(screen.getByLabelText("Switch to Beta Client"));

    expect(
      await screen.findByText("Your access to that workspace was removed."),
    ).toBeTruthy();
    expect(screen.queryByText(/Switched to/)).toBeNull();
  });

  it("does not report a no-op switch as a workspace change", async () => {
    mockSwitch.mockResolvedValue({
      switched: false,
      workspaceName: "Beta Client",
    });
    loaded([CURRENT, SIBLING]);
    await renderSwitcher();
    await openSheet();
    fireEvent.press(screen.getByLabelText("Switch to Beta Client"));

    expect(await screen.findByText("Already in Beta Client.")).toBeTruthy();
  });
});
