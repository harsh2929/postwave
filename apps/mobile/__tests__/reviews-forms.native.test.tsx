/**
 * The Reviews and Forms route modules render a bounded native state.
 *
 * WHY A SEPARATE FILE. `routes.native.test.tsx` enumerates every route it was
 * written with, and neither `(tabs)/reviews` nor `(tabs)/forms` was in it —
 * so "the moderation queue mounts" was an unproven claim about the highest
 * severity finding in this cluster (MAP#45, whose stated blocker was that the
 * screen could not be shown to be reachable). Adding a file rather than a row
 * to the shared enumeration keeps the two edits independent.
 *
 * WHAT THESE ASSERT, AND WHAT THEY DELIBERATELY DO NOT. `@tanstack/react-query`
 * is mocked to a permanent `isLoading: true`, so what is pinned here is that
 * each module composes, resolves every import, and renders a bounded FIRST
 * frame — the state a cold launch actually shows. Loaded-state behaviour lives
 * in the colocated pure-module tests (lib/reviewQueue, components/discounts/
 * discountStatus), which run in the node vitest environment where they can be
 * driven with real payloads.
 */
import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import type { ComponentType } from "react";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Discounts from "../app/(tabs)/discounts";
import FormDetail from "../app/(tabs)/forms/[id]";
import Forms from "../app/(tabs)/forms/index";
import Reviews from "../app/(tabs)/reviews";

const ROUTES: readonly (readonly [string, ComponentType])[] = [
  ["review moderation queue", Reviews],
  ["forms catalogue", Forms],
  ["form detail", FormDetail],
  // Re-rendered here as well as in routes.native.test.tsx: this file is the
  // one that follows the discount card through its extraction into
  // components/discounts, so a broken import there fails next to its cause.
  ["discounts", Discounts],
];

function renderRoute(Component: ComponentType) {
  return render(React.createElement(Component), {
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

describe("reviews and forms route modules render a bounded native state", () => {
  it.each(ROUTES)("renders %s", async (_name, Component) => {
    const result = await renderRoute(Component);
    expect(result.toJSON()).not.toBeNull();
  });
});

describe("the review queue's first frame", () => {
  it("names itself and offers the three moderation buckets", async () => {
    const screen = await renderRoute(Reviews);
    // The header proves the route module — not a fallback boundary — is what
    // rendered, which is the part MAP#45 could not previously assert.
    expect(screen.getAllByText("Reviews").length).toBeGreaterThan(0);
    // The status filter is the queue's spine: pending is the working set,
    // and the other two are where a decision lands.
    expect(screen.getByText("Queue")).toBeTruthy();
    expect(screen.getByText("Published")).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
  });
});
