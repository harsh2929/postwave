/**
 * The root shell's four previously-untestable behaviours, exercised by
 * rendering the REAL `app/_layout.tsx` (SHELL#78 made this possible: the
 * lifecycle concerns now live in hooks mounted below Toast/Confirm, instead of
 * inside a 617-line component that could only be smoke-rendered).
 *
 *  - SHELL#62  the splash cannot hang forever. A hydration that never settles
 *              is released by a watchdog into a STATED degraded state.
 *  - SHELL#71  an unrecognised deep link tells the user, instead of dropping
 *              them on the last screen as if nothing happened.
 *  - SHELL#72  the killed-app Approve path uses the app's confirm sheet and one
 *              toast, not three stacked OS alerts. Plus the authorization fact
 *              read from the handler: deciding is owner/admin only
 *              (requireAdmin in apps/api/internal/approvals/handlers.go), so a
 *              viewer is told why rather than being sent into a guaranteed 403.
 *  - NATIVE#47 a share-inbox queue with items left in it says so, and offers a
 *              way through the rest.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import RootLayout from "../app/_layout";


/* eslint-disable @typescript-eslint/no-explicit-any */
const authStore = require("@/store/auth") as any;
const connectivity = require("@/lib/connectivity") as any;
const deepLinks = require("@/lib/deepLinks") as any;
const pendingRoute = require("@/lib/pendingRoute") as any;
const push = require("@/lib/push") as any;
const queryClientModule = require("@/lib/queryClient") as any;
const sharedInbox = require("@/lib/sharedInbox") as any;
const Linking = require("expo-linking") as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function mount() {
  return await render(<RootLayout />, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
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
}

beforeEach(() => {
  // The shared root-runtime mock is a Proxy whose defaults are deliberately
  // vague; these are the exact shapes the shell calls at launch.
  authStore.useAuthStore.getState().hydrated = true;
  authStore.useAuthStore.getState().session.effectiveRole = "owner";
  queryClientModule.queryClient.invalidateQueries = jest.fn();
  connectivity.isProbablyOnline = () => true;
  // Default: nothing queued anywhere, so each test opts INTO its own trigger.
  pendingRoute.takePendingRoute = () => null;
  sharedInbox.takeSharedInboxItem = () => null;
  sharedInbox.pendingSharedInboxCount = () => 0;
  push.lastNotificationResponse = async () => null;
  Linking.getInitialURL.mockResolvedValue(null);
});

describe("SHELL#62 — the splash cannot hang forever", () => {
  it("paints nothing while hydration is still in flight", async () => {
    authStore.useAuthStore.getState().hydrated = false;
    await mount();
    // The old failure mode: this is where the user stays, under a native
    // splash that preventAutoHideAsync() is holding up, with no way out.
    expect(screen.queryByTestId("mock-navigator")).toBeNull();
  });

  it("paints the navigator and no notice on a healthy start", async () => {
    await mount();
    expect(screen.getByTestId("mock-navigator")).toBeTruthy();
    expect(screen.queryByText("Couldn't read your saved sign-in")).toBeNull();
  });

  // The watchdog RELEASE (hold → paint + stated reason) is exercised against
  // the hook that owns the timer, in __tests__/startup-gate.native.test.tsx:
  // advancing the clock inside the whole shell also fires every reconnect and
  // animation timer the app schedules at launch.
});

describe("SHELL#71 — unrecognised deep links", () => {
  it("tells the user, without echoing the link back", async () => {
    Linking.getInitialURL.mockResolvedValue(
      "moosewave://not-a-route?proof=SECRET-PROOF-VALUE",
    );
    deepLinks.planDeepLinkNavigation = () => ({ kind: "ignore" });
    await mount();

    const toast = await screen.findByText(
      "That link couldn't be opened — Moosewave didn't recognise it. It may have expired or need a newer app version.",
    );
    expect(toast).toBeTruthy();
    expect(screen.queryByText(/SECRET-PROOF-VALUE/)).toBeNull();
  });

  it("stays silent on an ordinary launch with no link", async () => {
    Linking.getInitialURL.mockResolvedValue(null);
    deepLinks.planDeepLinkNavigation = () => ({ kind: "ignore" });
    await mount();
    await act(async () => undefined);
    expect(screen.queryByText(/didn't recognise it/)).toBeNull();
  });
});

describe("SHELL#72 / NATIVE#37 — deciding an approval from a killed app", () => {
  beforeEach(() => {
    push.PUSH_ACTION_APPROVE = "postwave.approve";
    push.PUSH_ACTION_REJECT = "postwave.reject";
    push.parseNotificationAction = () => ({
      actionIdentifier: "postwave.approve",
      eventType: "approval.requested",
      entityId: "ap_123",
    });
    push.lastNotificationResponse = async () => ({ notification: {} });
  });

  it("asks with the app's confirm sheet, then confirms with ONE toast", async () => {
    const decide = jest.fn(async () => true);
    push.decideApprovalFromNotification = decide;

    await mount();

    // The sheet, not Alert.alert: it is rendered by this tree, so it can be
    // queried. An OS alert could not be.
    expect(await screen.findByText("Approve this request?")).toBeTruthy();
    expect(
      screen.getByText(
        "Open Approvals first if you need to review more context. This decision is recorded immediately.",
      ),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Approve"));
    });

    // The third argument is the reject reason (GOVERNANCE#37) — undefined for
    // an approve, which has no equivalent requirement.
    expect(decide).toHaveBeenCalledWith("ap_123", "approve", undefined);
    expect(await screen.findByText("Request approved.")).toBeTruthy();
    // Exactly one outcome surface — the old flow stacked a second dialog.
    expect(screen.queryByText("Approve this request?")).toBeNull();
  });

  it("does not send a decision the user cancelled", async () => {
    const decide = jest.fn(async () => true);
    push.decideApprovalFromNotification = decide;

    await mount();
    expect(await screen.findByText("Approve this request?")).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Cancel"));
    });

    expect(decide).not.toHaveBeenCalled();
  });

  it("reports a failed online decision without claiming success", async () => {
    push.decideApprovalFromNotification = async () => false;
    connectivity.isProbablyOnline = () => true;

    await mount();
    expect(await screen.findByText("Approve this request?")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Approve"));
    });

    expect(
      await screen.findByText(
        "Couldn't record that — the request may already have been decided or expired. Open Approvals to check.",
      ),
    ).toBeTruthy();
  });

  it("refuses a role the server would 403, instead of POSTing", async () => {
    // POST /api/v1/approvals/{id}/approve calls requireAdmin, which admits
    // only owner|admin. A viewer used to get the confirm, the POST, and then
    // "may already have been decided or expired" — which is a lie.
    authStore.useAuthStore.getState().session.effectiveRole = "viewer";
    const decide = jest.fn(async () => true);
    push.decideApprovalFromNotification = decide;

    await mount();

    expect(
      await screen.findByText(
        "Deciding approvals requires an owner or admin role in this workspace.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Approve this request?")).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });
});

/**
 * GOVERNANCE#37 — the notification button was the one door around the rule that
 * every rejection carries a reason. `rejectDraftSubmitState` refuses to build a
 * reasonless reject in-app; the push path POSTed `{decision:"reject"}` with no
 * `notes` at all, and the requester got a bare rejection.
 *
 * The property under test is negative and absolute: THERE IS NO PATH THROUGH
 * THIS HANDLER THAT SENDS A REJECT WITHOUT A REASON.
 */
describe("GOVERNANCE#37 — rejecting from a notification carries its reason", () => {
  function rejectResponse(userText?: string) {
    push.PUSH_ACTION_APPROVE = "postwave.approve";
    push.PUSH_ACTION_REJECT = "postwave.reject";
    push.parseNotificationAction = () => ({
      actionIdentifier: "postwave.reject",
      eventType: "approval.requested",
      entityId: "ap_123",
      userText,
    });
    push.lastNotificationResponse = async () => ({ notification: {} });
  }

  it("sends the reason the OS collected, and shows it back first", async () => {
    rejectResponse("  Budget not approved for Q3  ");
    const decide = jest.fn(async () => true);
    push.decideApprovalFromNotification = decide;

    await mount();

    // Echoed, because the approver can no longer see the field they typed in
    // and it is about to be written to a row the requester reads.
    expect(
      await screen.findByText(
        'The requester will see: "Budget not approved for Q3". This decision is recorded immediately.',
      ),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Reject"));
    });

    expect(decide).toHaveBeenCalledWith(
      "ap_123",
      "reject",
      "Budget not approved for Q3",
    );
    expect(await screen.findByText("Request rejected.")).toBeTruthy();
  });

  it("never POSTs a reasonless reject — it opens the request instead", async () => {
    rejectResponse(undefined); // platform gave us no text at all
    const decide = jest.fn(async () => true);
    push.decideApprovalFromNotification = decide;

    await mount();

    expect(
      await screen.findByText(
        "Add a reason to reject — the requester needs to know what to fix.",
      ),
    ).toBeTruthy();
    // The decision never left the device.
    expect(decide).not.toHaveBeenCalled();
    // And no confirm sheet was offered, because confirming would have been a
    // reasonless reject.
    expect(screen.queryByText("Reject this request?")).toBeNull();
  });

  it("treats an empty submit as no reason", async () => {
    rejectResponse("   ");
    const decide = jest.fn(async () => true);
    push.decideApprovalFromNotification = decide;

    await mount();

    expect(
      await screen.findByText(
        "Add a reason to reject — the requester needs to know what to fix.",
      ),
    ).toBeTruthy();
    expect(decide).not.toHaveBeenCalled();
  });

  it("still refuses a role the server would 403 before asking for a reason", async () => {
    // Ordering matters: telling a viewer to type a justification for a
    // decision they cannot make is worse than telling them they cannot.
    authStore.useAuthStore.getState().session.effectiveRole = "viewer";
    rejectResponse(undefined);
    const decide = jest.fn(async () => true);
    push.decideApprovalFromNotification = decide;

    await mount();

    expect(
      await screen.findByText(
        "Deciding approvals requires an owner or admin role in this workspace.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Add a reason to reject/)).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("NATIVE#47 — the share inbox acknowledges what is left", () => {
  it("says how many remain and offers a way through them", async () => {
    let remaining = 2;
    sharedInbox.takeSharedInboxItem = () => ({
      kind: "entity",
      value: "moosewave://campaign/abc",
      createdAt: Math.floor(Date.now() / 1000),
    });
    sharedInbox.actionForSharedItem = () => ({
      type: "navigate",
      href: "/(tabs)/campaigns",
    });
    sharedInbox.pendingSharedInboxCount = () => remaining;

    await mount();

    expect(
      await screen.findByText("2 more shared items are waiting."),
    ).toBeTruthy();

    remaining = 1;
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open next"));
    });

    expect(
      await screen.findByText("1 more shared item is waiting."),
    ).toBeTruthy();
  });

  it("says nothing when the queue is empty after the one it opened", async () => {
    sharedInbox.takeSharedInboxItem = () => ({
      kind: "entity",
      value: "moosewave://campaign/abc",
      createdAt: Math.floor(Date.now() / 1000),
    });
    sharedInbox.actionForSharedItem = () => ({
      type: "navigate",
      href: "/(tabs)/campaigns",
    });
    sharedInbox.pendingSharedInboxCount = () => 0;

    await mount();
    await act(async () => undefined);
    expect(screen.queryByText(/shared item/)).toBeNull();
  });

  it("says nothing when the App Group could not be read at all", async () => {
    // ABSENCE IS NOT ZERO — and it is not "0 more" either.
    sharedInbox.takeSharedInboxItem = () => ({
      kind: "entity",
      value: "moosewave://campaign/abc",
      createdAt: Math.floor(Date.now() / 1000),
    });
    sharedInbox.actionForSharedItem = () => ({
      type: "navigate",
      href: "/(tabs)/campaigns",
    });
    sharedInbox.pendingSharedInboxCount = () => null;

    await mount();
    await act(async () => undefined);
    expect(screen.queryByText(/shared item/)).toBeNull();
  });
});
