import { describe, expect, it, jest, afterEach } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React, { type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The Analytics screen's only predictive WRITE.
 *
 * Three claims, each of which fails silently if it breaks:
 *
 *  - the route is admin-only in routeauth/manifest.json, so a viewer must get
 *    the SENTENCE, not a button that 403s on press;
 *  - the run is confirmed before it starts — it rewrites the coverage rollup
 *    and the RFM bands the card above is displaying;
 *  - the result is rendered in the SERVER'S numbers. A run that scored nothing
 *    must say "0 profiles scored", because "recomputed" with no count is how a
 *    reader concludes coverage improved when it cannot have.
 */
const mockRecompute = jest.fn();

jest.mock("@/api/predictiveRecompute", () => ({
  postPredictiveRecompute: (...args: unknown[]) => mockRecompute(...args),
}));

// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import { ConfirmProvider } from "@/components/ConfirmSheet";
// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";
// eslint-disable-next-line import/first
import { PredictiveRecomputeAction } from "@/components/analytics/PredictiveRecomputeAction";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const RESULT = {
  run: {
    status: "completed",
    modelVersion: "heuristic-v1",
    windowDays: 365,
    scoredProfiles: 0,
    insufficientProfiles: 12,
    completedAt: "2026-09-03T08:00:00Z",
    error: "",
  },
  predictions: 0,
  rfmScores: 0,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

async function press(label: string) {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label));
  });
}

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  mockRecompute.mockReset();
});

describe("PredictiveRecomputeAction", () => {
  it("gives a viewer the reason instead of a button that would 403", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    await render(<PredictiveRecomputeAction />, { wrapper });
    expect(
      screen.getByText(/needs an admin role in this workspace/u),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Recompute the predictive model")).toBeNull();
  });

  it("confirms before running, and reports the run in the server's numbers", async () => {
    mockRecompute.mockImplementation(async () => RESULT);
    await render(<PredictiveRecomputeAction />, { wrapper });

    await press("Recompute the predictive model");
    // Nothing has been written yet: the sheet is the gate.
    expect(mockRecompute).not.toHaveBeenCalled();
    expect(screen.getByText(/rescores every customer profile/u)).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText("Recompute"));
    });

    expect(mockRecompute).toHaveBeenCalledTimes(1);
    // The zero is the point: this run scored nothing and says so. The
    // sentence lands twice — the toast that confirms the write, and the report
    // that stays on the card after it fades.
    expect(
      screen.getAllByText(/Run completed: 0 profiles scored/u).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("Read 365 days of history · model heuristic-v1."),
    ).toBeTruthy();
  });

  it("reads a 403 as the admin rule, not as a fault", async () => {
    mockRecompute.mockImplementation(async () => {
      throw Object.assign(new Error("forbidden"), { status: 403 });
    });
    await render(<PredictiveRecomputeAction />, { wrapper });
    await press("Recompute the predictive model");
    await act(async () => {
      fireEvent.press(screen.getByText("Recompute"));
    });
    expect(
      screen.getAllByText(/needs an admin role in this workspace/u).length,
    ).toBeGreaterThan(0);
  });

  it("refuses offline, where a synchronous server run cannot happen", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    await render(<PredictiveRecomputeAction />, { wrapper });
    const button = screen.getByLabelText("Recompute the predictive model");
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText(/needs a connection/u)).toBeTruthy();
  });
});
