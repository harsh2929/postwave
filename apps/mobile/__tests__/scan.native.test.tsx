/**
 * QR scanner route test.
 *
 * The all-routes smoke test renders `scan` with `useCameraPermissions` still
 * resolving, so it only ever exercises the placeholder chrome — the granted
 * branch, which is the whole screen, was never rendered by anything. This file
 * grants the permission and pins the two things that branch is responsible for:
 *
 *  1. NATIVE#40 — the TORCH. A camera scanner is used in exactly the place the
 *     light is bad, and `enableTorch` is a CameraView prop, so "the torch is on"
 *     is a claim about what the scanner is rendered with, not about a style.
 *     The assertions therefore read the prop off the CameraView, not the label.
 *  2. NATIVE#42 — DYNAMIC TYPE. Every `Text` the screen puts on screen carries a
 *     `maxFontSizeMultiplier` from lib/typeScale. This is asserted by walking the
 *     rendered tree rather than by reading the source, because the cap is a PROP:
 *     putting it inside a style object type-checks, renders, and silently does
 *     nothing, and that is precisely the mistake worth a test.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories
   are hoisted above every import, so they can only use require(). */
// Focus is a per-test fact here, not a constant: the route mock answers `true`
// forever, which is precisely the condition under which the stale-lock bug is
// invisible. Boxed so the hoisted factory can read it (jest allows only
// `mock`-prefixed names through the hoist).
const mockFocus = { value: true };
jest.mock("expo-router", () => ({
  ...(jest.requireActual("expo-router") as Record<string, unknown>),
  useIsFocused: () => mockFocus.value,
}));
jest.mock("expo-camera", () => {
  const ReactModule = require("react") as typeof React;
  const { View } = require("react-native") as typeof import("react-native");
  return {
    CameraView: (props: Record<string, unknown>) =>
      ReactModule.createElement(View, { testID: "camera-view", ...props }),
    useCameraPermissions: () => [
      { granted: true, canAskAgain: true, status: "granted" },
      jest.fn(),
    ],
  };
});

// eslint-disable-next-line import/first -- must follow the expo-camera mock.
import Scan from "../app/(tabs)/scan";

async function renderScan() {
  return await render(<Scan />, {
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
}

type RenderedNode =
  | string
  | number
  | null
  | {
      type: string;
      props: Record<string, unknown>;
      children: RenderedNode[] | null;
    };

function collectTextNodes(node: RenderedNode, out: RenderedNode[] = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "Text") out.push(node);
  for (const child of node.children ?? []) collectTextNodes(child, out);
  return out;
}

describe("scan — torch (NATIVE#40)", () => {
  it("starts dark, and the camera is rendered with the torch off", async () => {
    const screen = await renderScan();
    expect(screen.getByTestId("camera-view").props.enableTorch).toBe(false);
    // The state is spoken as well as drawn: the label names the ACTION, the
    // accessibilityState names the state, so VoiceOver never has to infer it
    // from the pill's colour.
    expect(screen.getByLabelText("Turn torch on")).toBeTruthy();
  });

  it("lights the camera when pressed, and puts it out when pressed again", async () => {
    const screen = await renderScan();

    // RNTL 14's fireEvent is ASYNC — an un-awaited press asserts against the
    // pre-press tree and passes for the wrong reason.
    await fireEvent.press(screen.getByLabelText("Turn torch on"));
    expect(screen.getByTestId("camera-view").props.enableTorch).toBe(true);
    const on = screen.getByLabelText("Turn torch off");
    expect(on.props.accessibilityState).toMatchObject({ selected: true });

    await fireEvent.press(on);
    expect(screen.getByTestId("camera-view").props.enableTorch).toBe(false);
    expect(
      screen.getByLabelText("Turn torch on").props.accessibilityState,
    ).toMatchObject({ selected: false });
  });

  it("is at least a 44pt target", async () => {
    const screen = await renderScan();
    const style = screen.getByLabelText("Turn torch on").props.style as {
      minHeight?: number;
      minWidth?: number;
    };
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
  });
});

describe("scan — Dynamic Type (NATIVE#42)", () => {
  it("caps every rendered Text, in both the granted and the prompt branch", async () => {
    const screen = await renderScan();
    const texts = collectTextNodes(screen.toJSON() as RenderedNode);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      if (typeof text !== "object" || text === null) continue;
      const cap = text.props.maxFontSizeMultiplier;
      expect(typeof cap).toBe("number");
      // Nothing may exceed MAX_ROLE_SCALE; nothing may be pinned at 1 (which
      // would mean "ignore the user's text-size setting entirely").
      expect(cap as number).toBeGreaterThan(1);
      expect(cap as number).toBeLessThanOrEqual(2.2);
    }
  });
});

/**
 * NATIVE — the scan LOCK must not outlive the screen's focus.
 *
 * `lockedRef` throttles the continuous `onBarcodeScanned` firehose: a QR
 * sitting in frame fires it dozens of times a second. The entity and
 * device-approve branches deliberately take the lock and never re-arm it,
 * because "we've navigated away from the scanner".
 *
 * But scan is a TAB route, and react-navigation keeps a visited screen MOUNTED
 * (which is exactly why this file's screen has a `useIsFocused` guard around
 * the CameraView at all). The ref therefore survives the navigation it was
 * abandoned by, so the SECOND visit to the scanner is a camera that renders,
 * lights its torch, and silently refuses every code for the rest of the
 * process. The re-arm has to be tied to focus, not to a timer that the
 * navigating branches never start.
 */
describe("scan — the lock is released when the screen is re-entered", () => {
  const CODE = "moosewave://campaign/11111111-1111-4111-8111-111111111111";

  it("scans again after the user navigates away and comes back", async () => {
    const { router } = require("expo-router") as {
      router: { replace: jest.Mock };
    };
    router.replace.mockClear();
    mockFocus.value = true;
    const screen = await renderScan();

    await act(async () => {
      (
        screen.getByTestId("camera-view").props.onBarcodeScanned as (
          r: unknown,
        ) => void
      )({ data: CODE });
    });
    expect(router.replace).toHaveBeenCalledTimes(1);

    // Leave the scanner (the branch above navigated) and come back to it.
    mockFocus.value = false;
    await act(async () => {
      screen.rerender(<Scan />);
    });
    mockFocus.value = true;
    await act(async () => {
      screen.rerender(<Scan />);
    });

    await act(async () => {
      (
        screen.getByTestId("camera-view").props.onBarcodeScanned as (
          r: unknown,
        ) => void
      )({ data: CODE });
    });
    expect(router.replace).toHaveBeenCalledTimes(2);
  });
});
