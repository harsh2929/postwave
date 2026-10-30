/**
 * The (tabs) shell's role denial (SHELL#63).
 *
 * THE BUG THIS PINS. `app/(tabs)/_layout.tsx` used to answer a failed role
 * check by returning `<MobileRouteAccessDenied/>` INSTEAD of `<Tabs>`. One
 * forbidden deep link therefore unmounted the entire tab navigator: the bottom
 * rail vanished, every tab's state went with it, and the only way out was a
 * single button. The regression is invisible to a snapshot — the denial DOES
 * render either way — so the assertion that matters is that the NAVIGATOR IS
 * STILL THERE beside it.
 *
 * The expo-router mock renders `<Tabs>` as a `View testID="mock-navigator"`,
 * so "the navigator is mounted" is directly observable. `usePathname` is the
 * only export overridden here; everything else comes from the shared mock.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

let mockPathname = "/(tabs)/dashboard";

jest.mock("expo-router", () => {
  const actual = jest.requireActual("expo-router") as Record<string, unknown>;
  return { ...actual, usePathname: () => mockPathname };
});

import TabsLayout from "../app/(tabs)/_layout";
import { router } from "expo-router";
import { useAuthStore } from "@/store/auth";
import { TAB_BAR_BASE_HEIGHT } from "@/lib/typeScale";

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

function treeHasTestID(node: RenderedNode, testID: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.props.testID === testID) return true;
  return (node.children ?? []).some((child) => treeHasTestID(child, testID));
}

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

type SessionLike = { effectiveRole: string; role: string };

function session(): SessionLike {
  return (
    useAuthStore as unknown as { getState: () => { session: SessionLike } }
  ).getState().session;
}

let originalRole = "owner";

beforeEach(() => {
  originalRole = session().effectiveRole;
  mockPathname = "/(tabs)/dashboard";
});

afterEach(() => {
  session().effectiveRole = originalRole;
  session().role = originalRole;
});

function setRole(role: string) {
  session().effectiveRole = role;
  session().role = role;
}

async function renderShell() {
  await render(<TabsLayout />, { wrapper });
}

describe("(tabs) shell role denial", () => {
  it("keeps the tab navigator mounted while denying a restricted route", async () => {
    setRole("viewer");
    mockPathname = "/(tabs)/migrations";
    await renderShell();

    // The whole point: BOTH are on screen at once.
    // The transition notice is intentionally modal to accessibility queries,
    // so inspect the rendered tree to prove the navigator remains mounted.
    expect(
      treeHasTestID(screen.toJSON() as RenderedNode, "mock-navigator"),
    ).toBe(true);
    expect(screen.getByTestId("secondary-route-denied")).toBeTruthy();
    expect(screen.getByText("Migrations is restricted")).toBeTruthy();
    expect(router.replace).toHaveBeenCalledWith({
      pathname: "/(tabs)/access-denied",
      params: { routeKey: "migrations" },
    });
  });

  it("leaves the tab bar's own strip uncovered by the denial", async () => {
    setRole("viewer");
    mockPathname = "/(tabs)/migrations";
    await renderShell();

    const style = screen.getByTestId("secondary-route-denied").props
      .style as Record<string, unknown>;
    expect(style.position).toBe("absolute");
    expect(style.top).toBe(0);
    // A denial that covered the rail would sit at bottom: 0. This one stops at
    // the bar's real height — the same tabBarHeightFor(fontScale) the navigator
    // is given — plus the 34pt bottom inset the SafeAreaProvider above supplies.
    expect(style.bottom).toBeGreaterThanOrEqual(TAB_BAR_BASE_HEIGHT + 34);
    expect(style.bottom).toBeLessThan(TAB_BAR_BASE_HEIGHT + 34 + 40);
  });

  it("caps every line of the denial for Dynamic Type", async () => {
    setRole("viewer");
    mockPathname = "/(tabs)/migrations";
    await renderShell();

    const texts = collectByType(screen.toJSON() as RenderedNode, "Text");
    expect(texts.length).toBe(3);
    for (const text of texts) {
      const cap = text.props.maxFontSizeMultiplier;
      expect(typeof cap).toBe("number");
      expect(cap as number).toBeGreaterThan(1);
      expect(cap as number).toBeLessThanOrEqual(2.2);
    }
  });

  it("offers a labelled, 44pt escape hatch", async () => {
    setRole("viewer");
    mockPathname = "/(tabs)/migrations";
    await renderShell();

    const button = screen.getByLabelText("Return to the More menu");
    expect(button.props.accessibilityRole).toBe("button");
    expect(
      (button.props.style as { minHeight?: number }).minHeight,
    ).toBeGreaterThanOrEqual(44);
  });

  it("temporarily isolates the covered scene from assistive technology", async () => {
    setRole("viewer");
    mockPathname = "/(tabs)/migrations";
    await renderShell();

    expect(
      screen.getByTestId("secondary-route-denied").props
        .accessibilityViewIsModal,
    ).toBe(true);
  });

  it("renders no denial on a primary tab, at the lowest role", async () => {
    setRole("viewer");
    mockPathname = "/(tabs)/dashboard";
    await renderShell();

    expect(
      treeHasTestID(screen.toJSON() as RenderedNode, "mock-navigator"),
    ).toBe(true);
    expect(screen.queryByTestId("secondary-route-denied")).toBeNull();
  });

  it("renders no denial on a restricted route for an admin", async () => {
    setRole("owner");
    mockPathname = "/(tabs)/migrations";
    await renderShell();

    expect(screen.getByTestId("mock-navigator")).toBeTruthy();
    expect(screen.queryByTestId("secondary-route-denied")).toBeNull();
  });

  it("denies nested paths under a restricted route too", async () => {
    setRole("editor");
    mockPathname = "/(tabs)/migrations/run-123";
    await renderShell();

    expect(
      treeHasTestID(screen.toJSON() as RenderedNode, "mock-navigator"),
    ).toBe(true);
    expect(screen.getByText("Migrations is restricted")).toBeTruthy();
  });
});
