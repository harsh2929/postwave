import { describe, expect, it, jest, afterEach, beforeEach } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";
import React, { useEffect } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ToastProvider, useToast, type ToastOptions } from "@/components/Toast";
import { TOAST_ACTION_MS, TOAST_DEFAULT_MS } from "@/lib/feedbackPolicy";

/**
 * The toast host used to show exactly ONE entry and replace it on the next
 * call. Two confirmations from one bulk action therefore discarded one of
 * them — and when the discarded one carried an undo, the destructive write
 * had already committed and its only recovery vanished with no trace.
 *
 * These tests pin the queue at the surface a user actually sees: what is on
 * screen, and when.
 */

function Fire({ toasts }: { toasts: readonly ToastOptions[] }) {
  const { toast } = useToast();
  useEffect(() => {
    for (const options of toasts) toast(options);
    // Fire exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Text>host</Text>;
}

function mount(toasts: readonly ToastOptions[]) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <Fire toasts={toasts} />
      </ToastProvider>
    </SafeAreaProvider>,
  );
}

/**
 * Advance past one toast's lifetime and let the queue drain.
 *
 * `await act(async …)` and not the sync form: draining is driven by an
 * EFFECT that runs when the visible entry clears, and the synchronous act
 * scope returns before React flushes it.
 */
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe("toast queue", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows the first toast and holds the second rather than discarding it", async () => {
    await mount([
      { kind: "success", message: "Suppressed hello@example.com" },
      { kind: "success", message: "Suppressed bye@example.com" },
    ]);

    expect(screen.getByText("Suppressed hello@example.com")).toBeTruthy();
    expect(screen.queryByText("Suppressed bye@example.com")).toBeNull();

    await advance(TOAST_DEFAULT_MS + 1);

    // The second one is not lost — it takes the screen when the first expires.
    expect(screen.queryByText("Suppressed hello@example.com")).toBeNull();
    expect(screen.getByText("Suppressed bye@example.com")).toBeTruthy();
  });

  it("gives a queued UNDO its own full action window", async () => {
    const onPress = jest.fn();
    await mount([
      { kind: "success", message: "Saved" },
      {
        kind: "success",
        message: "Deleted the draft",
        action: { label: "Undo", onPress },
      },
    ]);

    await advance(TOAST_DEFAULT_MS + 1);
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toBeTruthy();

    // Still there most of the way through the 6s action window — a queued
    // undo must not inherit the leftovers of the previous toast's timer.
    await advance(TOAST_ACTION_MS - 500);
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("collapses an identical repeated failure instead of queueing it N times", async () => {
    await mount([
      { kind: "error", message: "Couldn't mark that read." },
      { kind: "error", message: "Couldn't mark that read." },
      { kind: "error", message: "Couldn't mark that read." },
    ]);

    expect(screen.getByText("Couldn't mark that read.")).toBeTruthy();
    await advance(TOAST_DEFAULT_MS + 1);
    // One message, one showing — the repeats did not stack up behind it.
    expect(screen.queryByText("Couldn't mark that read.")).toBeNull();
  });

  it("lets an error take the screen from a routine confirmation without losing it", async () => {
    await mount([
      { kind: "success", message: "Saved" },
      { kind: "error", message: "Send failed" },
    ]);

    // The error is time-critical, so it does not wait its turn.
    expect(screen.getByText("Send failed")).toBeTruthy();

    await advance(TOAST_DEFAULT_MS + 1);
    // …and the confirmation it displaced comes back rather than vanishing.
    expect(screen.getByText("Saved")).toBeTruthy();
  });
});
