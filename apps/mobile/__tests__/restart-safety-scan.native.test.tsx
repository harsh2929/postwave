/**
 * AppUpdateSection's pre-restart safety scan (parity register,
 * shell-crosscutting "pre-restart safety scan before applying an app update:
 * enumerate registered unsaved work, block or warn, defer-for-4h reminder";
 * desktop anchor DesktopUpdateService restartDecision over the lifecycle
 * guards).
 *
 * The point of the item is that the confirm CARRIES FACTS, so the assertions
 * are about facts reaching the surface — never about a dialog existing:
 *
 *  1. NOTHING IS CLAIMED UNTIL AN UPDATE IS STAGED. A card with no update
 *     shows no safety verdict at all; claiming "restart-safe" for a restart
 *     nobody offered is a promise about state that was never scanned.
 *  2. AN UNSAVED EDITOR IS NAMED and downgrades the button to "Restart
 *     anyway"; the confirm repeats the concern, and cancelling it DEFERS
 *     rather than restarting.
 *  3. A SHARE STILL ON SCREEN BLOCKS: the button is disabled, says so to a
 *     screen reader, and the update is never applied.
 *
 * The two registries are the REAL ones (lib/dirtyGuard, lib/transferCenter),
 * driven through their own public writers, so the card is wired to the state
 * the rest of the app actually keeps. Only the update state machine itself is
 * mocked — it reaches for expo-updates natively.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { AppUpdateState } from "@/lib/appUpdatePolicy";

const mockApplied: number[] = [];
const mockChecked: number[] = [];
let mockState: AppUpdateState = {
  phase: "ready",
  lastCheckedAt: Date.parse("2026-09-03T09:00:00Z"),
  error: null,
};

jest.mock("@/hooks/useAppUpdate", () => ({
  __esModule: true,
  useAppUpdate: () => ({
    state: mockState,
    check: () => {
      mockChecked.push(1);
    },
    restart: async () => {
      mockApplied.push(1);
    },
  }),
  applyAppUpdate: async () => {
    mockApplied.push(1);
  },
  useAppUpdateWatcher: () => undefined,
  resetAppUpdateState: () => undefined,
}));

import { ConfirmProvider } from "@/components/ConfirmSheet";
import {
  AppUpdateSection,
  RESTART_SAFE_LINE,
} from "@/components/diagnostics/AppUpdateSection";
import { ToastProvider } from "@/components/Toast";
import { RESTART_DEFERRED_TOAST } from "@/hooks/useRestartSafety";
import { markDirty, resetDirtyGuard } from "@/lib/dirtyGuard";
import {
  clearRestartReminder,
  restartReminderAt,
} from "@/lib/restartSafetyScan";
import {
  resetTransferCenterForTests,
  startLocalTransfer,
} from "@/lib/transferCenter";

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ConfirmProvider>
        <ToastProvider>{children}</ToastProvider>
      </ConfirmProvider>
    </SafeAreaProvider>
  );
}

const renderCard = () => render(<AppUpdateSection />, { wrapper });

beforeEach(() => {
  mockState = {
    phase: "ready",
    lastCheckedAt: Date.parse("2026-09-03T09:00:00Z"),
    error: null,
  };
});

afterEach(() => {
  mockApplied.length = 0;
  mockChecked.length = 0;
  resetDirtyGuard();
  resetTransferCenterForTests();
  clearRestartReminder();
});

describe("pre-restart safety scan", () => {
  it("claims nothing about restart safety while there is no update to apply", async () => {
    mockState = { phase: "up-to-date", lastCheckedAt: Date.now(), error: null };
    markDirty("workspace", "Workspace");
    await renderCard();

    expect(screen.getByText("Moosewave is up to date")).toBeTruthy();
    expect(screen.queryByText(RESTART_SAFE_LINE)).toBeNull();
    expect(screen.queryByText("Review · Unsaved edits in Workspace")).toBeNull();
    // The one verb offered is the check, and it does not restart anything.
    await fireEvent.press(screen.getByLabelText("Check for a Moosewave update"));
    expect(mockChecked).toEqual([1]);
    expect(mockApplied).toEqual([]);
  });

  it("says the scan found nothing, and restarts on the single tap", async () => {
    await renderCard();
    expect(screen.getByText("Update ready")).toBeTruthy();
    expect(screen.getByText(RESTART_SAFE_LINE)).toBeTruthy();

    await fireEvent.press(
      screen.getByLabelText("Restart Moosewave to finish installing the update"),
    );
    expect(mockApplied).toEqual([1]);
  });

  it("names the unsaved editor, repeats it in the confirm, and defers on cancel", async () => {
    markDirty("workspace", "Workspace");
    markDirty("webhook-form", "Outbound webhook");
    await renderCard();

    // Both editors are named, in one sentence, before anything is pressed.
    expect(
      screen.getByText("Review · Unsaved edits in Workspace and Outbound webhook"),
    ).toBeTruthy();
    expect(screen.queryByText(RESTART_SAFE_LINE)).toBeNull();
    expect(screen.getByText("Restart anyway")).toBeTruthy();

    await fireEvent.press(
      screen.getByLabelText("Restart Moosewave to finish installing the update"),
    );
    expect(screen.getByText("Restart with work in progress?")).toBeTruthy();
    expect(
      screen.getByText(
        "Unsaved edits in Workspace and Outbound webhook — Restarting discards what has been typed but not saved.",
      ),
    ).toBeTruthy();

    // Cancel is the 4-hour deferral, not a silent dismissal.
    await fireEvent.press(screen.getByLabelText("Remind me in 4 hours"));
    expect(mockApplied).toEqual([]);
    expect(restartReminderAt()).not.toBeNull();
    expect(await screen.findByText(RESTART_DEFERRED_TOAST)).toBeTruthy();
  });

  it("applies the update when the person confirms over the warnings", async () => {
    markDirty("workspace", "Workspace");
    await renderCard();
    await fireEvent.press(
      screen.getByLabelText("Restart Moosewave to finish installing the update"),
    );
    await fireEvent.press(screen.getByLabelText("Restart anyway"));
    expect(mockApplied).toEqual([1]);
    expect(restartReminderAt()).toBeNull();
  });

  it("blocks on a share sheet still open and never applies the update", async () => {
    startLocalTransfer({ scope: "s1", direction: "share", label: "Diagnostics report" });
    await renderCard();

    expect(screen.getByText("Blocking · 1 share still open")).toBeTruthy();
    const button = screen.getByLabelText(
      "Restart is blocked until the work above finishes",
    );
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText("Restart blocked")).toBeTruthy();

    await fireEvent.press(button);
    expect(mockApplied).toEqual([]);
  });
});
