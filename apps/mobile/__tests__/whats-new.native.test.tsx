/**
 * The in-app what's-new CARD (its badge half is pinned in
 * whats-new-badge.native.test.tsx — same registry, different surface).
 *
 * What a policy unit test cannot reach, and this pins:
 *   - the card withholds itself until the dismissal record has been READ, so a
 *     card the user put down weeks ago never flashes on a cold start;
 *   - dismissing advances to the next announcement AND survives a remount,
 *     because the dismissal is persisted rather than component state;
 *   - once the shared 30-day window closes it renders nothing, with no code
 *     change and no stored flag.
 *
 * Time is pinned by stubbing Date.now rather than with fake timers, so
 * Testing Library's async helpers keep running on real timers.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";

import { WhatsNewCard } from "../src/components/more/WhatsNewCard";
import { NEW_FEATURES } from "../src/lib/newFeatures";

const DAY_MS = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = require("./mocks/asyncStorage.cjs") as {
  clear: () => Promise<void>;
};

/** The day after everything in the registry shipped: every entry is live. */
function insideWindow(): number {
  return Math.max(...NEW_FEATURES.map((e) => Date.parse(e.shippedAt))) + DAY_MS;
}

/** Long after the newest entry expired: nothing is live. */
function pastWindow(): number {
  return insideWindow() + 400 * DAY_MS;
}

function pinNow(value: number): void {
  jest.spyOn(Date, "now").mockReturnValue(value);
}

beforeEach(async () => {
  await storage.clear();
});

/**
 * Render and let the dismissal read land. The wait is explicit because the
 * card is deliberately EMPTY until it does — asserting on the first frame
 * would both test the wrong thing and leak a state update into the next test.
 */
async function renderCard() {
  const view = await render(
    <WhatsNewCard effectiveRole="owner" mode="session" />,
  );
  // The read is one microtask deep; a second flush settles the state it sets.
  await view;
  return view;
}

describe("what's-new card", () => {
  it("shows the newest live announcement once the dismissal record is read", async () => {
    pinNow(insideWindow());
    const view = await renderCard();
    await waitFor(() => expect(screen.getByText("WHAT'S NEW")).toBeTruthy());
    expect(screen.getByLabelText("Open Billing")).toBeTruthy();
    expect(screen.getByText(/Plan & usage now shows API sends/)).toBeTruthy();
    view.unmount();
  });

  it("advances to the next announcement, and remembers the dismissal across a remount", async () => {
    pinNow(insideWindow());
    const first = await renderCard();
    await waitFor(() =>
      expect(screen.getByLabelText("Open Billing")).toBeTruthy(),
    );
    fireEvent.press(
      screen.getByLabelText(
        "Dismiss this announcement about API usage & cost dashboard",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Open Billing")).toBeNull(),
    );
    expect(screen.getByLabelText("Open Settings")).toBeTruthy();
    first.unmount();

    // The dismissal was PERSISTED, so a fresh mount does not bring it back.
    const second = await renderCard();
    await waitFor(() =>
      expect(screen.getByLabelText("Open Settings")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Open Billing")).toBeNull();
    second.unmount();
  });

  it("renders nothing at all once the window has closed", async () => {
    pinNow(pastWindow());
    const view = await renderCard();
    expect(view.toJSON()).toBeNull();
    view.unmount();
  });
});
