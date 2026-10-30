/**
 * SHELL#62 — the launch watchdog, tested at the seam that owns the timer.
 *
 * The whole root layout is deliberately NOT mounted here: advancing the clock
 * by eight seconds inside the full shell also fires every reconnect, poll and
 * animation timer the app schedules at launch, which tests the scheduler more
 * than the gate. The chain is covered in three pieces instead —
 * `startupGateState` (pure, src/lib/startupGate.test.ts), this hook (the timer
 * and the splash dismissal), and `app/_layout.tsx`'s `if (!proceed) return
 * null` (__tests__/root-shell.native.test.tsx).
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";
import React from "react";
import { Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { StartupDegradedNotice } from "@/components/StartupDegradedNotice";
import { useHydrationGate } from "@/hooks/useHydrationGate";
import { STARTUP_WATCHDOG_MS } from "@/lib/startupGate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const authStore = require("@/store/auth") as any;

function Probe() {
  const gate = useHydrationGate();
  return (
    <View>
      <Text testID="gate">{gate.proceed ? "painting" : "holding"}</Text>
      <StartupDegradedNotice reason={gate.degraded} />
    </View>
  );
}

function safeAreaWrapper({ children }: { children: React.ReactNode }) {
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

async function mount() {
  return await render(<Probe />, { wrapper: safeAreaWrapper });
}

beforeEach(() => {
  authStore.useAuthStore.getState().hydrated = true;
});

describe("useHydrationGate", () => {
  it("paints straight away when hydration has already landed", async () => {
    await mount();
    expect(screen.getByTestId("gate").props.children).toBe("painting");
  });

  it("holds, then releases with a stated reason when hydration never settles", async () => {
    jest.useFakeTimers();
    try {
      authStore.useAuthStore.getState().hydrated = false;
      await mount();
      // Before the watchdog this is the forever-splash the finding describes.
      expect(screen.getByTestId("gate").props.children).toBe("holding");
      expect(screen.queryByText("Couldn't read your saved sign-in")).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(STARTUP_WATCHDOG_MS + 1);
      });

      expect(screen.getByTestId("gate").props.children).toBe("painting");
      expect(screen.getByText("Couldn't read your saved sign-in")).toBeTruthy();
      // The notice must rule out data loss: this state is otherwise
      // indistinguishable from "the app forgot my account".
      expect(
        screen.getByLabelText(
          "Couldn't read your saved sign-in. This device didn't answer in time, so you may need to sign in again. Nothing was deleted.",
        ),
      ).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not arm the watchdog once everything has settled", async () => {
    jest.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        jest.advanceTimersByTime(STARTUP_WATCHDOG_MS * 3);
      });
      // A late timer must not paint a "couldn't read your sign-in" bar over a
      // perfectly good session.
      expect(screen.getByTestId("gate").props.children).toBe("painting");
      expect(screen.queryByText("Couldn't read your saved sign-in")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("StartupDegradedNotice", () => {
  it("renders nothing on a healthy launch", async () => {
    const result = await render(<StartupDegradedNotice reason={null} />, {
      wrapper: safeAreaWrapper,
    });
    // `toJSON()` is the whole tree INCLUDING the SafeAreaProvider wrapper, so
    // it is never null here — assert the notice contributed no children of its
    // own, which is the actual claim: a healthy launch shows no banner.
    const tree = result.toJSON() as { children?: unknown[] } | null;
    expect(tree?.children ?? []).toHaveLength(0);
  });

  it("caps Dynamic Type on every line it renders", async () => {
    await render(<StartupDegradedNotice reason="fonts" />, {
      wrapper: safeAreaWrapper,
    });
    // The cap is a PROP: written into a style object it type-checks and does
    // nothing, so it is asserted against the rendered tree.
    for (const copy of [
      "Showing the system font",
      "Moosewave's typefaces didn't load on this launch. Everything works — only the type looks different.",
    ]) {
      expect(
        typeof screen.getByText(copy).props.maxFontSizeMultiplier,
      ).toBe("number");
    }
  });
});
