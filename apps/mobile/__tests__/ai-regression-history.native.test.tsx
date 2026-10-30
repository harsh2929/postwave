/**
 * AiRegressionHistorySheet — the render contract (register: AI regression
 * evidence workspace, ai).
 *
 * The three wire shapes and the severity reading are pinned in
 * src/lib/aiRegressionRuns.test.ts; this file pins the workspace:
 *
 *  - the history list carries a verdict per run, and a run whose gate is
 *    `advisory` is NOT shown as passing;
 *  - a tap drills into that run's per-surface rollup and per-example results;
 *  - an example whose replay failed shows "Replay failed" and the server's
 *    reason — never a 0 score;
 *  - an empty history says so instead of implying a clean bill of health.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type {
  RegressionResultWire,
  RegressionRunDetailWire,
} from "@/lib/aiRegressionRuns";

const mockRuns = {
  data: [] as RegressionRunDetailWire[],
  isLoading: false,
  isError: false,
  error: null as Error | null,
  refetch: jest.fn(),
};
const mockResults = {
  data: null as {
    run: RegressionRunDetailWire | null;
    results: RegressionResultWire[];
  } | null,
  isLoading: false,
  isError: false,
  error: null as Error | null,
  refetch: jest.fn(),
};
let mockOpenedRunId: string | null = null;
jest.mock("@/hooks/useAiRegressionRuns", () => ({
  REGRESSION_HISTORY_LIMIT: 25,
  useRegressionRuns: () => mockRuns,
  useRegressionRunResults: (runId: string | null) => {
    mockOpenedRunId = runId;
    return mockResults;
  },
}));

// eslint-disable-next-line import/first -- must follow the mock above.
import { AiRegressionHistorySheet } from "@/components/voice/AiRegressionHistorySheet";

const ADVISORY_RUN: RegressionRunDetailWire = {
  id: "run-advisory",
  model_version_tag: "v4-canary",
  status: "completed",
  gate_result: "advisory",
  total_examples: 4,
  passed_examples: 3,
  error_examples: 1,
  fidelity_score_mean: 77.6,
  completed_at: new Date().toISOString(),
};

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
  mockRuns.data = [];
  mockRuns.isLoading = false;
  mockRuns.isError = false;
  mockResults.data = null;
  mockResults.isLoading = false;
  mockResults.isError = false;
  mockOpenedRunId = null;
});

describe("AiRegressionHistorySheet", () => {
  it("labels an advisory run as advisory, never as passing", async () => {
    mockRuns.data = [ADVISORY_RUN];
    await render(<AiRegressionHistorySheet visible onClose={jest.fn()} />, {
      wrapper,
    });
    expect(screen.getByText("Run history")).toBeTruthy();
    expect(screen.getByText("v4-canary")).toBeTruthy();
    expect(screen.getByText("Advisory only")).toBeTruthy();
    expect(screen.queryByText("Passing")).toBeNull();
    // The unscored example is reported, not folded into the denominator.
    expect(screen.getByText(/4 examples · 1 not scored/)).toBeTruthy();
  });

  it("drills into one run's rollup and results", async () => {
    mockRuns.data = [ADVISORY_RUN];
    mockResults.data = {
      run: {
        ...ADVISORY_RUN,
        by_surface: {
          subject_line: {
            total: 4,
            scored: 3,
            errors: 1,
            passed: 3,
            mean_score: 77.6,
          },
        },
      },
      results: [
        {
          id: "res-1",
          surface_kind: "subject_line",
          severity: "ok",
          fidelity_score: 88,
          brief: "Write a subject for the spring sale",
        },
        {
          id: "res-2",
          surface_kind: "subject_line",
          severity: "error",
          fidelity_score: null,
          error_message: "the provider timed out",
        },
      ],
    };
    await render(<AiRegressionHistorySheet visible onClose={jest.fn()} />, {
      wrapper,
    });
    await fireEvent.press(
      screen.getByLabelText("Open run v4-canary: Advisory only"),
    );
    // The results query is only asked for once a run is open.
    expect(mockOpenedRunId).toBe("run-advisory");
    expect(screen.getByText("Run evidence")).toBeTruthy();
    expect(screen.getByText("Subject line — 3 of 4 passed · 1 not scored")).toBeTruthy();
    expect(screen.getByText("88 / 100")).toBeTruthy();
    // The failed replay reads as missing evidence, not as a zero score.
    expect(screen.getByText("Replay failed")).toBeTruthy();
    expect(screen.getByText("the provider timed out")).toBeTruthy();
    expect(screen.queryByText("0 / 100")).toBeNull();
  });

  it("returns to the list from a drill-in", async () => {
    mockRuns.data = [ADVISORY_RUN];
    mockResults.data = { run: ADVISORY_RUN, results: [] };
    await render(<AiRegressionHistorySheet visible onClose={jest.fn()} />, {
      wrapper,
    });
    await fireEvent.press(
      screen.getByLabelText("Open run v4-canary: Advisory only"),
    );
    expect(screen.getByText("This run recorded no per-example results.")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Back to run history"));
    expect(screen.getByText("Run history")).toBeTruthy();
  });

  it("says the harness has never run rather than implying a clean result", async () => {
    mockRuns.data = [];
    await render(<AiRegressionHistorySheet visible onClose={jest.fn()} />, {
      wrapper,
    });
    expect(
      screen.getByText(
        "No regression run has happened for this workspace yet.",
      ),
    ).toBeTruthy();
  });

  it("shows the failed read with a retry, and asks for nothing while closed", async () => {
    mockRuns.isError = true;
    mockRuns.error = new Error(
      "Regression history needs reporting access. Ask an admin.",
    );
    await render(<AiRegressionHistorySheet visible onClose={jest.fn()} />, {
      wrapper,
    });
    expect(
      screen.getByText("Regression history needs reporting access. Ask an admin."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Retry")).toBeTruthy();
  });

  it("renders nothing at all while closed", async () => {
    mockRuns.data = [ADVISORY_RUN];
    await render(
      <AiRegressionHistorySheet visible={false} onClose={jest.fn()} />,
      { wrapper },
    );
    expect(screen.queryByText("Run history")).toBeNull();
  });
});
