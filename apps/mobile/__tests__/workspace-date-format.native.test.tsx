/**
 * WorkspaceSettingsSection's date-format picker — the render contract
 * (register: workspace date-format preference, settings).
 *
 * The option set / summary / patch policy is pinned in
 * src/lib/workspaceDateFormat.test.ts; this file pins the control:
 *
 *  - all four formats are offered, labelled as desktop labels them, with the
 *    SAVED one selected and the others not;
 *  - an unset column says so rather than pre-selecting the server default;
 *  - choosing one arms Save and PATCHes date_format ALONE — the other four
 *    fields on this form are untouched;
 *  - a field edited alongside it still sends both;
 *  - the picker sits inside the workspace form on the Settings screen;
 *  - what a save says afterwards arrives as a toast, the Settings screen's
 *    after-the-action channel, and never as a modal Alert that costs a tap.
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
import { Alert } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ToastProvider } from "@/components/Toast";
import { WORKSPACE_DATE_FORMAT_REJECTED } from "@/lib/workspaceDateFormat";
import * as AuthStore from "@/store/auth";

const SAVED = {
  tenant_id: "t1",
  display_name: "Acme",
  default_reply_to: "hello@acme.com",
  timezone: "Europe/London",
  date_format: "MMM D, YYYY",
  brand_color: "#C8102E",
  logo_url: "",
  updated_at: "2026-09-01T10:00:00Z",
};

const mockPatchCalls: unknown[] = [];
let mockWorkspace: Record<string, unknown> = { ...SAVED };
/** When set, the PATCH answers with this error instead of the merged row. */
let mockPatchError: { status: number; message: string } | null = null;
jest.mock("@/api/settings", () => ({
  ...(jest.requireActual("@/api/settings") as Record<string, unknown>),
  getWorkspaceSettings: async () => ({ data: mockWorkspace, error: null }),
  patchWorkspaceSettings: async (patch: unknown) => {
    mockPatchCalls.push(patch);
    if (mockPatchError) return { data: null, error: mockPatchError };
    return { data: { ...mockWorkspace, ...(patch as object) }, error: null };
  },
}));

// eslint-disable-next-line import/first -- must follow the api mock.
import { WorkspaceSettingsSection } from "@/components/settings/WorkspaceSettingsSection";
// eslint-disable-next-line import/first
import Settings from "../app/(tabs)/settings";

const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

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

const SAVE = "Save workspace settings";

/** The section loads in an effect; the first frame is the loading line. */
async function renderLoaded() {
  const view = await render(<WorkspaceSettingsSection />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

type Host = ReturnType<typeof screen.getByText>;

/**
 * The role the toast host wraps `message` in: "alert" for an error and only
 * an error (Toast.tsx), "text" for any other kind. The host View is not an
 * accessibility element, so getByRole cannot reach it; walking up from the
 * words on screen can — and throws when they are not inside a toast at all.
 */
function toastRole(message: string): unknown {
  let node: Host | null = screen.getByText(message);
  while (node && node.props.accessibilityLiveRegion === undefined) {
    node = node.parent;
  }
  if (!node) throw new Error(`"${message}" is not inside a toast`);
  return node.props.accessibilityRole;
}

/** Mounted under the real toast host, as the Settings screen mounts it. */
async function renderInToastHost() {
  const view = await render(
    <ToastProvider>
      <WorkspaceSettingsSection />
    </ToastProvider>,
    { wrapper },
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

afterEach(() => {
  mockPatchCalls.length = 0;
  mockWorkspace = { ...SAVED };
  mockPatchError = null;
  authHarness.__resetAuthStateForTests();
});

describe("workspace date format", () => {
  it("offers the four formats desktop offers, with the saved one selected", async () => {
    await renderLoaded();
    const selected = screen.getByLabelText("May 3, 2026 (MMM D, YYYY)");
    expect(selected.props.accessibilityState.selected).toBe(true);
    for (const label of [
      "3 May 2026 (D MMM YYYY)",
      "2026-05-03 (YYYY-MM-DD)",
      "05/03/2026 (MM/DD/YYYY)",
    ]) {
      expect(screen.getByLabelText(label).props.accessibilityState.selected).toBe(
        false,
      );
    }
    expect(screen.getByText("Dates render as May 3, 2026.")).toBeTruthy();
    expect(screen.getByLabelText(SAVE).props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it("says the column is UNSET rather than pre-selecting the default", async () => {
    mockWorkspace = { ...SAVED, date_format: "" };
    await renderLoaded();
    expect(
      screen.getByText(
        "Not set — dates render as May 3, 2026 until you choose one.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("May 3, 2026 (MMM D, YYYY)").props.accessibilityState
        .selected,
    ).toBe(false);
  });

  it("PATCHes date_format alone when only the format changed", async () => {
    await renderLoaded();
    await fireEvent.press(screen.getByLabelText("2026-05-03 (YYYY-MM-DD)"));
    expect(screen.getByLabelText(SAVE).props.accessibilityState.disabled).toBe(
      false,
    );
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPatchCalls).toEqual([{ date_format: "YYYY-MM-DD" }]);
  });

  it("carries the format alongside another edited field", async () => {
    await renderLoaded();
    await fireEvent.changeText(screen.getByLabelText("Display name"), "Acme Ltd");
    await fireEvent.press(screen.getByLabelText("3 May 2026 (D MMM YYYY)"));
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPatchCalls).toEqual([
      { display_name: "Acme Ltd", date_format: "D MMM YYYY" },
    ]);
  });

  it("does not send the format when something else changed and it did not", async () => {
    await renderLoaded();
    await fireEvent.changeText(screen.getByLabelText("Timezone"), "Asia/Tokyo");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPatchCalls).toEqual([{ timezone: "Asia/Tokyo" }]);
  });

  it("re-selects the format the SERVER echoed back after a save", async () => {
    await renderLoaded();
    await fireEvent.press(screen.getByLabelText("05/03/2026 (MM/DD/YYYY)"));
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(
      screen.getByLabelText("05/03/2026 (MM/DD/YYYY)").props.accessibilityState
        .selected,
    ).toBe(true);
    expect(screen.getByText("Dates render as 05/03/2026.")).toBeTruthy();
  });

  it("is reachable in the workspace form on the Settings screen", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "admin", effectiveRole: "admin", tenantId: "t1" },
    });
    await render(<Settings />, { wrapper });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Workspace date format")).toBeTruthy();
  });
});

describe("workspace settings save feedback", () => {
  // Spied, never let through: a real Alert here would be a modal the user has
  // to dismiss after every save — the exact cost the toast exists to remove.
  let alertSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  });
  afterEach(() => {
    alertSpy.mockRestore();
  });

  it("confirms a save with a toast, not a modal Alert", async () => {
    await renderInToastHost();
    await fireEvent.press(screen.getByLabelText("2026-05-03 (YYYY-MM-DD)"));
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPatchCalls).toEqual([{ date_format: "YYYY-MM-DD" }]);
    expect(toastRole("Workspace settings updated.")).toBe("text");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("reports a refused save as an ERROR toast and keeps the edit", async () => {
    mockPatchError = { status: 400, message: "timezone must be an IANA zone" };
    await renderInToastHost();
    await fireEvent.changeText(screen.getByLabelText("Timezone"), "Mars/Olympus");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPatchCalls).toEqual([{ timezone: "Mars/Olympus" }]);
    expect(
      toastRole("Couldn't save workspace settings. timezone must be an IANA zone"),
    ).toBe("alert");
    expect(screen.queryByText("Workspace settings updated.")).toBeNull();
    expect(screen.getByLabelText("Timezone").props.value).toBe("Mars/Olympus");
    expect(screen.getByLabelText(SAVE).props.accessibilityState.disabled).toBe(
      false,
    );
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("refuses a format this build does not know in an error toast, sending nothing", async () => {
    mockWorkspace = { ...SAVED, date_format: "DD.MM.YYYY" };
    await renderInToastHost();
    await fireEvent.changeText(screen.getByLabelText("Display name"), "Acme Ltd");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPatchCalls).toEqual([]);
    expect(toastRole(WORKSPACE_DATE_FORMAT_REJECTED)).toBe("alert");
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
