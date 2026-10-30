import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Diagnostics from "../app/(tabs)/diagnostics";

/**
 * The diagnostics screen is the surface support asks a customer to open when
 * something native has gone wrong, so "does it render at all" is not enough:
 * the rows that make a report actionable, and the share affordance itself,
 * have to be present and reachable by their spoken labels.
 */
describe("diagnostics screen", () => {
  it("renders the support report rows and the share action", async () => {
    const result = await render(React.createElement(Diagnostics), {
      wrapper: ({ children }) => (
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
    expect(result.toJSON()).not.toBeNull();
    expect(result.getByLabelText("Share a diagnostics report with support")).toBeTruthy();
    expect(result.getByText("Build profile")).toBeTruthy();
    expect(result.getByText("Push token")).toBeTruthy();
    expect(result.getByText("Unsent changes")).toBeTruthy();
    expect(result.getByText("Offline queue")).toBeTruthy();
    // A coloured dot is never the only signal for stream health.
    expect(result.getByLabelText(/Live updates/)).toBeTruthy();
    // NATIVE#43: the locale every formatter runs under. Support's first
    // question when a customer says "the dates are wrong".
    expect(result.getByText("Locale")).toBeTruthy();
  });

  it("carries the in-app update surface (NATIVE#3 / SHELL#29)", async () => {
    const result = await render(React.createElement(Diagnostics), {
      wrapper: ({ children }) => (
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
    expect(result.getByText("App updates")).toBeTruthy();
    // The bundle's provenance is the whole reason support asks for this
    // screen: which channel the binary polls, and which bundle it is running.
    // Each row is one spoken "label: value" rather than two loose runs.
    expect(result.getByLabelText(/^Update channel: /)).toBeTruthy();
    expect(result.getByLabelText(/^Runtime version: /)).toBeTruthy();
    expect(result.getByLabelText(/^Running bundle: /)).toBeTruthy();

    // The control is reachable by its spoken label and meets the touch floor.
    // (The build-without-a-channel case renders NO control at all; that is
    // pinned in src/lib/appUpdatePolicy.test.ts, where `enabled` can be false
    // — jest-expo's expo-updates mock always reports an enabled build.)
    const check = result.getByLabelText("Check for a Moosewave update");
    expect(check.props.accessibilityRole).toBe("button");
    const style = Array.isArray(check.props.style)
      ? Object.assign({}, ...check.props.style)
      : check.props.style;
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });

  it("offers the share action as a ≥44pt labelled button", async () => {
    const result = await render(React.createElement(Diagnostics), {
      wrapper: ({ children }) => (
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
    const share = result.getByLabelText(
      "Share a diagnostics report with support",
    );
    expect(share.props.accessibilityRole).toBe("button");
    const style = Array.isArray(share.props.style)
      ? Object.assign({}, ...share.props.style)
      : share.props.style;
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });
});
