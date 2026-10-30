/**
 * LifecycleSection — the render contract for the lifecycle rollup.
 *
 * The pure merge is pinned in `src/lib/lifecycleDistribution.test.ts` and the
 * transport seam in `src/api/lifecycleRollup.test.ts`; this file pins what the
 * ANALYTICS reader actually sees:
 *
 *  - stage rows render with their counts (the wire from hook to screen);
 *  - a deployment with no lifecycle routes renders NOTHING, not an error;
 *  - an empty workspace gets the honest sentence, not a wall of zero bars;
 *  - a failed read reaches the error state instead of vanishing.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

type Query = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
};

function query(data: unknown, over: Partial<Query> = {}): Query {
  return {
    data,
    error: null,
    isLoading: false,
    isError: false,
    refetch: jest.fn(async () => undefined),
    ...over,
  };
}

let mockQuery: Query = query(undefined, { isLoading: true });

jest.mock("@/hooks/useLifecycleDistribution", () => ({
  useLifecycleDistribution: () => mockQuery,
}));

// eslint-disable-next-line import/first -- must follow the hook mock.
import { LifecycleSection } from "@/components/analytics/LifecycleSection";
// eslint-disable-next-line import/first
import { buildLifecycleView } from "@/lib/lifecycleDistribution";

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

afterEach(() => {
  mockQuery = query(undefined, { isLoading: true });
});

describe("LifecycleSection", () => {
  it("renders every stage the view carries, zero stages included", async () => {
    mockQuery = query(
      buildLifecycleView(
        [{ stage: "customer", count: 5 }],
        ["subscriber", "lead", "customer"],
      ),
    );
    await render(<LifecycleSection />, { wrapper });
    expect(screen.getByText("Subscriber")).toBeTruthy();
    expect(screen.getByText("Lead")).toBeTruthy();
    expect(screen.getByText("Customer")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    // The honesty note: this is a rollup, the write lives on the profile.
    expect(
      screen.getByText(/edited on each subscriber's profile/),
    ).toBeTruthy();
  });

  it("renders NOTHING when the deployment has no lifecycle routes", async () => {
    mockQuery = query(null);
    await render(<LifecycleSection />, { wrapper });
    expect(screen.queryByText("Lifecycle stages")).toBeNull();
  });

  it("says an empty workspace is empty rather than drawing zero bars", async () => {
    mockQuery = query(buildLifecycleView([], ["subscriber", "lead"]));
    await render(<LifecycleSection />, { wrapper });
    expect(
      screen.getByText("No active subscribers to place in lifecycle stages yet."),
    ).toBeTruthy();
    expect(screen.queryByText("Subscriber")).toBeNull();
  });

  it("surfaces a failed read as the error state, not as absence", async () => {
    mockQuery = query(undefined, {
      isError: true,
      error: Object.assign(new Error("boom"), { status: 500 }),
    });
    await render(<LifecycleSection />, { wrapper });
    expect(screen.getByText("Lifecycle stages")).toBeTruthy();
    expect(screen.getAllByText(/Try again/i).length).toBeGreaterThan(0);
  });
});
