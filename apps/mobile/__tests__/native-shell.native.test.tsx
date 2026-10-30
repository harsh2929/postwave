/**
 * The two screens that render when the rest of the app cannot: the root error
 * boundary, and the below-version-floor blocking screen. Neither had a render
 * test (NATIVE#51) — they are the two surfaces most likely to be reached by a
 * user in trouble and least likely to be exercised by anyone in development.
 *
 * What is pinned here:
 *
 *  - The 426 GATE IS DRIVEN BY THE PARSER, not by a prop. The test feeds a real
 *    `upgrade_required` problem document — the exact shape
 *    apps/api/internal/middleware/client_version.go writes — through
 *    `parseUpgradeRequired` into `reportUpgradeRequired`, and asserts the gate
 *    flips from null to the blocking screen. That is the whole NATIVE#3 chain
 *    minus the transport.
 *  - A 426 that is NOT an upgrade document leaves the gate closed, so a captive
 *    portal or a proxy cannot lock a user out of their own app.
 *  - DYNAMIC TYPE (NATIVE#42). Every `Text` both screens render carries a
 *    `maxFontSizeMultiplier`. Asserted against the rendered tree, because the
 *    cap is a PROP: written into a style object it type-checks and does nothing.
 *  - The error boundary SCROLLS. Centred-and-clipped is the failure mode at a
 *    2x accessibility size, and it takes the "Try again" button off screen.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppErrorBoundary } from "../src/components/AppErrorBoundary";
import {
  UpgradeRequiredGate,
  UpgradeRequiredScreen,
} from "../src/components/UpgradeRequiredScreen";
import {
  clearUpgradeRequirement,
  parseUpgradeRequired,
  reportUpgradeRequired,
} from "../src/lib/upgradeRequired";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { height: 844, width: 390, x: 0, y: 0 },
      insets: { bottom: 34, left: 0, right: 0, top: 47 },
    }}
  >
    {children}
  </SafeAreaProvider>
);

type RenderedNode =
  | string
  | number
  | null
  | {
      type: string;
      props: Record<string, unknown>;
      children: RenderedNode[] | null;
    };

function collectByType(
  node: RenderedNode,
  type: string,
  out: Exclude<RenderedNode, string | number | null>[] = [],
) {
  if (!node || typeof node !== "object") return out;
  if (node.type === type) out.push(node);
  for (const child of node.children ?? []) collectByType(child, type, out);
  return out;
}

function expectEveryTextCapped(tree: RenderedNode) {
  const texts = collectByType(tree, "Text");
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) {
    const cap = text.props.maxFontSizeMultiplier;
    expect(typeof cap).toBe("number");
    expect(cap as number).toBeGreaterThan(1);
    expect(cap as number).toBeLessThanOrEqual(2.2);
  }
}

/** The exact body middleware/client_version.go writes for a below-floor build. */
const GATEWAY_426_BODY = JSON.stringify({
  status: 426,
  title: "Upgrade required",
  code: "upgrade_required",
  detail: "This app version is no longer supported. Please update to continue.",
  min_version: "2.4.0",
  current_version: "1.9.3",
  client: "mobile",
  request_id: "api-7f3c/abc123-000042",
});

describe("AppErrorBoundary", () => {
  it("renders the recovery card and calls retry", async () => {
    const retry = jest.fn(async () => undefined);
    const screen = await render(
      <AppErrorBoundary error={new Error("boom")} retry={retry} />,
      { wrapper },
    );

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Try again"));
    expect(retry).toHaveBeenCalled();
  });

  it("scrolls rather than centring text it cannot fit", async () => {
    const screen = await render(
      <AppErrorBoundary error={new Error("boom")} retry={jest.fn(async () => undefined)} />,
      { wrapper },
    );
    const scrollers = collectByType(
      screen.toJSON() as RenderedNode,
      "RCTScrollView",
    );
    expect(scrollers.length).toBeGreaterThan(0);
  });

  it("caps every Text it renders", async () => {
    const screen = await render(
      <AppErrorBoundary error={new Error("boom")} retry={jest.fn(async () => undefined)} />,
      { wrapper },
    );
    expectEveryTextCapped(screen.toJSON() as RenderedNode);
  });
});

describe("UpgradeRequiredScreen (NATIVE#3)", () => {
  beforeEach(() => {
    clearUpgradeRequirement();
  });

  it("renders nothing until a 426 has actually been observed", async () => {
    const gate = await render(<UpgradeRequiredGate />, { wrapper });
    // The only node in the tree is the SafeAreaProvider the wrapper supplies.
    expect(
      (gate.toJSON() as { children: unknown[] | null } | null)?.children ?? [],
    ).toHaveLength(0);
  });

  it("refuses to open on a 426 that is not an upgrade_required document", () => {
    // A captive portal, or a proxy with its own opinion about 426, must never
    // be able to lock a user out of their own app.
    expect(parseUpgradeRequired("<html>you must sign in to wifi</html>")).toBe(
      null,
    );
    expect(parseUpgradeRequired({ code: "rate_limited" })).toBe(null);
    expect(parseUpgradeRequired({ min_version: "2.4.0" })).toBe(null);
  });

  it("opens on the gateway's document and shows both versions", async () => {
    const requirement = parseUpgradeRequired(GATEWAY_426_BODY);
    expect(requirement).not.toBeNull();
    reportUpgradeRequired(requirement!);

    const gate = await render(<UpgradeRequiredGate />, { wrapper });
    expect(gate.getByText("Update Moosewave")).toBeTruthy();
    // Both version numbers the gateway echoed are shown, so the user can see
    // WHY they are blocked rather than only that they are.
    expect(gate.getByText("You have 1.9.3 · Minimum 2.4.0")).toBeTruthy();
    expect(gate.getByText("Reference api-7f3c/abc123-000042")).toBeTruthy();
  });

  it("offers no way past itself — the server has already refused", async () => {
    const requirement = parseUpgradeRequired(GATEWAY_426_BODY)!;
    const screen = await render(
      <UpgradeRequiredScreen requirement={requirement} />,
      { wrapper },
    );
    const buttons = collectByType(
      screen.toJSON() as RenderedNode,
      "View",
    ).filter((node) => node.props.accessibilityRole === "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props.accessibilityLabel).toBe(
      "Open the app store to update Moosewave",
    );
  });

  it("caps every Text it renders", async () => {
    const requirement = parseUpgradeRequired(GATEWAY_426_BODY)!;
    const screen = await render(
      <UpgradeRequiredScreen requirement={requirement} />,
      { wrapper },
    );
    expectEveryTextCapped(screen.toJSON() as RenderedNode);
  });
});
