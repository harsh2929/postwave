/**
 * Settings consumes `?anchor=` — the palette's Settings-section rows land.
 *
 * lib/paletteSettingsItems routes "App lock" to /(tabs)/settings?anchor=app-lock
 * and hooks/useSettingsAnchorParam is the consumer; this pins that the SCREEN
 * actually calls it with its registry and its jump. The hook's own timing is
 * pinned in palette-param-hooks.native.test.tsx; here the question is only
 * "is it wired", and the observable is the jump's own outcome.
 *
 * In this renderer no onLayout ever fires, so no section registers an offset
 * and the jump — once its patience runs out — takes the branch it takes for
 * a section that never mounted: the role notice toast. That is the screen's
 * existing jumpToSection speaking, reached through the param; a screen that
 * ignored the param would show no toast and never clear it. The negative
 * control (no param → no toast, no clear) is what keeps this falsifiable.
 *
 * `router.setParams` is not on the expo-router mock (owned elsewhere), so it
 * is attached per test and removed again.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, waitFor } from "@testing-library/react-native";
import * as ExpoRouter from "expo-router";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockToasts: Array<{ kind: string; message: string }> = [];
jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: (entry: { kind: string; message: string }) => {
      mockToasts.push(entry);
    },
    dismiss: () => undefined,
  }),
}));

// eslint-disable-next-line import/first -- must follow the toast mock.
import Settings from "../app/(tabs)/settings";

const routerHarness = ExpoRouter as unknown as {
  __setSearchParamsForTests: (over: Record<string, string> | null) => void;
  router: { setParams?: jest.Mock };
};

const ROLE_NOTICE = "That section isn't available for your workspace role.";

beforeEach(() => {
  mockToasts.length = 0;
  routerHarness.router.setParams = jest.fn();
});

afterEach(() => {
  routerHarness.__setSearchParamsForTests(null);
  delete routerHarness.router.setParams;
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 1400));

describe("Settings arriving with ?anchor=", () => {
  it("does nothing without the param", async () => {
    await render(<Settings />, { wrapper });
    await settle();

    expect(mockToasts).toEqual([]);
    expect(routerHarness.router.setParams).not.toHaveBeenCalled();
  });

  it("hands a declared anchor to the screen's own jump and clears the param", async () => {
    routerHarness.__setSearchParamsForTests({ anchor: "app-lock" });

    await render(<Settings />, { wrapper });

    await waitFor(
      () =>
        expect(mockToasts).toContainEqual({
          kind: "info",
          message: ROLE_NOTICE,
        }),
      { timeout: 3000 },
    );
    expect(routerHarness.router.setParams).toHaveBeenCalledWith({
      anchor: undefined,
    });
  });

  it("ignores an anchor the IA does not declare — no jump, no notice, no clear", async () => {
    routerHarness.__setSearchParamsForTests({ anchor: "nope" });

    await render(<Settings />, { wrapper });
    await settle();

    expect(mockToasts).toEqual([]);
    expect(routerHarness.router.setParams).not.toHaveBeenCalled();
  });
});
