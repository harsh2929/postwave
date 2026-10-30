/**
 * NATIVE#47 — a share the app consumed but could not deliver goes back.
 *
 * `takeSharedInboxItem()` commits the App Group queue rewrite BEFORE it hands
 * the item back (src/lib/sharedInbox.ts), deliberately: a storage fault must
 * never let the app replay a share it already processed. The consequence is
 * that every exit from the drain loop that is not "navigated" DESTROYS
 * user-initiated content. Two of those exits should — a malformed entry and a
 * non-actionable one are exactly what the queue exists to shed — and one
 * should not: an item that resolved to a real action the router then refused.
 *
 * `restoreSharedInboxItem` was written for that third case and had no caller,
 * so the share was silently and unrecoverably gone with nothing on screen to
 * say so. These tests pin the three outcomes apart from each other, and pin the
 * loop-control decision that goes with the restore: it must STOP, because the
 * next `takeSharedInboxItem()` would pop the item it just put back and spin.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import RootLayout from "../app/_layout";

/* eslint-disable @typescript-eslint/no-explicit-any */
const authStore = require("@/store/auth") as any;
const connectivity = require("@/lib/connectivity") as any;
const pendingRoute = require("@/lib/pendingRoute") as any;
const push = require("@/lib/push") as any;
const queryClientModule = require("@/lib/queryClient") as any;
const sharedInbox = require("@/lib/sharedInbox") as any;
const Linking = require("expo-linking") as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const ITEM = Object.freeze({
  kind: "entity" as const,
  value: "moosewave://campaign/abc",
  createdAt: 1_700_000_000,
});

/** One item, then an empty queue — so a loop that spins runs out rather than hanging. */
function queueOf(...items: unknown[]) {
  const remaining = [...items];
  return jest.fn(() => remaining.shift() ?? null);
}

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
  authStore.useAuthStore.getState().hydrated = true;
  authStore.useAuthStore.getState().session.effectiveRole = "owner";
  queryClientModule.queryClient.invalidateQueries = jest.fn();
  connectivity.isProbablyOnline = () => true;
  pendingRoute.takePendingRoute = () => null;
  push.lastNotificationResponse = async () => null;
  Linking.getInitialURL.mockResolvedValue(null);
  sharedInbox.takeSharedInboxItem = () => null;
  sharedInbox.actionForSharedItem = () => null;
  sharedInbox.pendingSharedInboxCount = () => 0;
  sharedInbox.restoreSharedInboxItem = jest.fn(() => true);
});

describe("NATIVE#47 — an undeliverable share is not destroyed", () => {
  it("puts back an actionable item the router refused, and stops draining", async () => {
    const take = queueOf(ITEM, ITEM);
    sharedInbox.takeSharedInboxItem = take;
    // A route the href parser cannot use — `useNavigateToHref` answers false
    // rather than throwing, which is the failure this path exists for.
    sharedInbox.actionForSharedItem = () => ({ type: "navigate", href: "" });

    await mount();
    await act(async () => undefined);

    expect(sharedInbox.restoreSharedInboxItem).toHaveBeenCalledTimes(1);
    expect(sharedInbox.restoreSharedInboxItem).toHaveBeenCalledWith(ITEM);
    // Exactly one take: continuing would pop the item just restored.
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("still discards a non-actionable entry rather than putting it back", async () => {
    // Malformed, expired or a generic URL — `actionForSharedItem` answers null
    // and the queue is supposed to shed it. Restoring here would make the
    // App Group retain exactly what its policy says it must not.
    const take = queueOf(ITEM);
    sharedInbox.takeSharedInboxItem = take;
    sharedInbox.actionForSharedItem = () => null;

    await mount();
    await act(async () => undefined);

    expect(sharedInbox.restoreSharedInboxItem).not.toHaveBeenCalled();
    // Skipped, then the drained queue ended the loop.
    expect(take).toHaveBeenCalledTimes(2);
  });

  it("does not put back an item it successfully opened", async () => {
    sharedInbox.takeSharedInboxItem = queueOf(ITEM);
    sharedInbox.actionForSharedItem = () => ({
      type: "navigate",
      href: "/(tabs)/campaigns",
    });

    await mount();
    await act(async () => undefined);

    expect(sharedInbox.restoreSharedInboxItem).not.toHaveBeenCalled();
  });

  it("says nothing to the user about a share it could not open", async () => {
    // The remaining-count toast offers "Open next", and the next attempt would
    // fail the same way. A count nobody can act on is noise, so the failure is
    // silent-but-preserved: the item is still there on the next foreground.
    sharedInbox.takeSharedInboxItem = queueOf(ITEM);
    sharedInbox.actionForSharedItem = () => ({ type: "navigate", href: "" });
    sharedInbox.pendingSharedInboxCount = () => 2;

    await mount();
    await act(async () => undefined);

    expect(screen.queryByText(/shared item/)).toBeNull();
  });
});
