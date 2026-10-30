/**
 * SectionBoundary — the sub-route blast radius, PROVEN rather than assumed.
 *
 * SHELL#47's route-granularity half is already closed and guarded:
 * `src/lib/routeErrorBoundary.consistency.test.ts` fails the build unless every
 * route module exports an `ErrorBoundary`, and 82 of them do. What was NOT
 * covered anywhere is the level below it. `SectionBoundary` is a hand-written
 * class component — `getDerivedStateFromError` + `componentDidCatch` + a
 * key-bumping retry — mounted on the More menu around the workspace identity
 * card, and `CardBoundary` does the same job on the dashboard. Neither had a
 * single test.
 *
 * That matters more than the usual "add coverage" argument. An error boundary
 * that does not catch fails SILENTLY IN THE GOOD CASE: nothing throws in
 * development, the fallback is never seen, and the first time anyone learns it
 * was mis-wired is when a real crash takes the screen. The three properties
 * asserted here are exactly the three that make it worth having:
 *
 *   1. It CONTAINS. The siblings around the throwing subtree keep rendering —
 *      on More, those siblings are the destination list, which is the only way
 *      to leave the screen.
 *   2. It REPORTS. A contained failure nobody is told about is a silent
 *      failure, which is the class of bug this app's audit was dominated by.
 *   3. Its RETRY IS REAL. It calls back so the caller can refetch the bad
 *      payload, and it remounts the subtree. Remounting alone would re-render
 *      the same cached data and throw again — a button that reliably does
 *      nothing.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { CardBoundary } from "@/components/dashboard/CardBoundary";
import {
  SectionBoundary,
  type SectionBoundaryProps,
} from "@/components/SectionBoundary";
import { captureRootError } from "@/lib/sentry";

// SectionBoundary is a CLASS, so `Parameters<typeof SectionBoundary>` is its
// constructor's, not its props'. The exported props interface is the honest
// source; only the theme bag is stubbed, and only the five tokens the
// fallback actually reads.
const tokens = {
  border: "#333",
  surface: "#111",
  fg: "#eee",
  fgMuted: "#aaa",
  accent: "#5b8",
} as unknown as SectionBoundaryProps["t"];

function Boom(): never {
  throw new Error("payload shape changed under us");
}

describe("SectionBoundary", () => {
  it("contains a throw and leaves its siblings rendering", async () => {
    // React logs the caught error to console.error; silencing keeps the run
    // readable without suppressing a genuine failure (the assertions below
    // are what prove the boundary worked).
    const noise = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await render(
        <>
          <Text accessibilityRole="header">Destinations</Text>
          <SectionBoundary label="Workspace" t={tokens}>
            <Boom />
          </SectionBoundary>
        </>,
      );
      // 1. CONTAINED: the sibling — on More, the navigation list — survives.
      expect(screen.getByRole("header", { name: "Destinations" })).toBeTruthy();
      // The fallback names the panel in the user's words, not a component name.
      expect(screen.getByText(/Workspace couldn’t load/u)).toBeTruthy();
      // 2. REPORTED through the app's own reporter, which applies redaction.
      expect(captureRootError).toHaveBeenCalled();
    } finally {
      noise.mockRestore();
    }
  });

  it("retries by calling back AND remounting, not one or the other", async () => {
    const noise = jest.spyOn(console, "error").mockImplementation(() => {});
    const onRetry = jest.fn();
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error("first render only");
      return <Text>Recovered</Text>;
    }
    try {
      await render(
        <SectionBoundary label="Delivery health" t={tokens} onRetry={onRetry}>
          <Flaky />
        </SectionBoundary>,
      );
      expect(screen.getByText(/Delivery health couldn’t load/u)).toBeTruthy();

      // The caller's refetch is what replaces the bad payload; the boundary
      // cannot know how to do that itself.
      shouldThrow = false;
      await fireEvent.press(
        screen.getByRole("button", { name: "Retry loading Delivery health" }),
      );
      expect(onRetry).toHaveBeenCalledTimes(1);
      // 3. And the subtree genuinely re-rendered rather than staying failed.
      expect(screen.getByText("Recovered")).toBeTruthy();
    } finally {
      noise.mockRestore();
    }
  });
});

describe("CardBoundary", () => {
  it("isolates one dashboard card and says which one failed", async () => {
    const noise = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await render(
        <>
          <Text accessibilityRole="header">Dashboard</Text>
          <CardBoundary
            label="Anomalies"
            colors={{ surface: "#111", border: "#333", text: "#eee" }}
          >
            <Boom />
          </CardBoundary>
        </>,
      );
      expect(screen.getByRole("header", { name: "Dashboard" })).toBeTruthy();
      // Spoken as a whole sentence: a screen-reader user must hear WHICH card
      // failed and that the rest of the screen is fine.
      expect(
        screen.getByLabelText(
          "Anomalies could not be displayed. The rest of this screen is unaffected.",
        ),
      ).toBeTruthy();
      expect(captureRootError).toHaveBeenCalled();
    } finally {
      noise.mockRestore();
    }
  });
});
