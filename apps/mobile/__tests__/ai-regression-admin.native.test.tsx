/**
 * AiRegressionCard's admin drill-in — the render contract (register: AI
 * regression administration, ai).
 *
 * The validation and refusal mapping are pinned in
 * src/lib/aiRegressionAdmin.test.ts; this file pins that they reach the screen:
 *
 *  - below admin, Manage and Save reference DO NOT EXIST (History does, because
 *    every history read is read:reports);
 *  - the recording-policy sentence tracks the DRAFT, so an operator reads the
 *    consequence of the values in front of them;
 *  - Save is inert while nothing changed, and sends all four fields when it
 *    does (the PUT is a whole-object replace);
 *  - a trigger refusal renders the SERVER'S OWN SENTENCE inside the sheet with
 *    no retry, because pressing again cannot change any of the three;
 *  - the golden-example form refuses locally rather than submitting a body the
 *    handler would reject.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
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

jest.mock("@/hooks/useAiRegression", () => ({
  useLatestRegressionRun: () => ({
    data: {
      id: "r1",
      status: "completed",
      gate_result: "pass",
      total_examples: 6,
      passed_examples: 6,
      fidelity_score_mean: 91,
    },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
}));

jest.mock("@/hooks/useAiRegressionRuns", () => ({
  REGRESSION_HISTORY_LIMIT: 25,
  useRegressionRuns: () => ({
    data: [],
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  }),
  useRegressionRunResults: () => ({
    data: null,
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  }),
}));

const SETTINGS = {
  warnThreshold: 60,
  hardGateEnabled: false,
  hardGateThreshold: 70,
  minExamplesForGate: 5,
};
const mockSave = { mutate: jest.fn(), isPending: false };
type Handlers = { onSuccess?: () => void; onError?: (e: Error) => void };
let mockTriggerError: Error | null = null;
const mockTrigger = {
  mutate: jest.fn((_body: unknown, handlers?: Handlers) => {
    if (mockTriggerError) handlers?.onError?.(mockTriggerError);
    else handlers?.onSuccess?.();
  }),
  isPending: false,
};
const mockCapture = { mutate: jest.fn(), isPending: false };
jest.mock("@/hooks/useAiRegressionAdmin", () => ({
  useRegressionSettings: () => ({
    data: SETTINGS,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useSaveRegressionSettings: () => mockSave,
  useTriggerRegressionRun: () => mockTrigger,
  useCaptureGoldenExample: () => mockCapture,
}));

// eslint-disable-next-line import/first -- must follow the mocks above.
import { AiRegressionCard } from "@/components/voice/AiRegressionCard";

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
  mockToasts.length = 0;
  mockSave.mutate.mockClear();
  mockTrigger.mutate.mockClear();
  mockCapture.mutate.mockClear();
  mockTriggerError = null;
});

async function openManage() {
  await render(<AiRegressionCard offline={false} canAdmin />, { wrapper });
  await fireEvent.press(screen.getByLabelText("Manage"));
}

describe("AiRegressionCard admin controls", () => {
  it("hides every admin verb below admin, and keeps History", async () => {
    await render(<AiRegressionCard offline={false} canAdmin={false} />, {
      wrapper,
    });
    expect(screen.queryByLabelText("Manage")).toBeNull();
    expect(screen.queryByLabelText("Save a golden reference")).toBeNull();
    // /runs is read:reports, so a viewer keeps the evidence workspace.
    expect(
      screen.getByLabelText("Browse regression run history"),
    ).toBeTruthy();
  });

  it("says a run can never be recorded as a failure while the gate is off", async () => {
    await openManage();
    expect(
      screen.getByText(/no run can be recorded as a failure/),
    ).toBeTruthy();
  });

  it("re-reads the consequence sentence off the DRAFT, not the stored row", async () => {
    await openManage();
    await fireEvent(
      screen.getByLabelText("Record failures using the hard gate"),
      "valueChange",
      true,
    );
    await fireEvent.changeText(
      screen.getByLabelText("Minimum scored examples"),
      "9",
    );
    expect(screen.getByText(/at least 9 scored examples/)).toBeTruthy();
  });

  it("refuses to save an unchanged form, then sends all four fields", async () => {
    await openManage();
    const save = screen.getByLabelText("No changes");
    expect(save.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText("Warn threshold"), "72");
    await fireEvent.press(screen.getByLabelText("Save settings"));
    expect(mockSave.mutate).toHaveBeenCalledTimes(1);
    expect(mockSave.mutate.mock.calls[0]?.[0]).toEqual({
      warn_threshold: 72,
      hard_gate_enabled: false,
      hard_gate_threshold: 70,
      min_examples_for_gate: 5,
    });
  });

  it("keeps a bad threshold on the device instead of spending a round trip", async () => {
    await openManage();
    await fireEvent.changeText(screen.getByLabelText("Warn threshold"), "150");
    await fireEvent.press(screen.getByLabelText("Save settings"));
    expect(mockSave.mutate).not.toHaveBeenCalled();
    expect(
      screen.getByText("warn_threshold must be between 0 and 100"),
    ).toBeTruthy();
  });

  it("requires the operator's label before triggering a replay", async () => {
    await openManage();
    await fireEvent.press(screen.getByLabelText("Run the harness"));
    expect(mockTrigger.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("model_version_tag is required")).toBeTruthy();
  });

  it("renders the server's refusal verbatim in the sheet, with no Retry", async () => {
    mockTriggerError = new Error(
      "a regression run is already in progress for this tenant",
    );
    await openManage();
    await fireEvent.changeText(
      screen.getByLabelText("Model version label"),
      "v9-canary",
    );
    await fireEvent.press(screen.getByLabelText("Run the harness"));
    expect(mockTrigger.mutate.mock.calls[0]?.[0]).toEqual({
      model_version_tag: "v9-canary",
    });
    expect(
      screen.getByText(
        "a regression run is already in progress for this tenant",
      ),
    ).toBeTruthy();
    // The refusal stays next to the control; it is not a toast that flashes
    // past, and there is nothing offering to repeat a press that cannot work.
    expect(mockToasts).toHaveLength(0);
    expect(screen.queryByLabelText("Retry")).toBeNull();
  });

  it("reports a queued run rather than claiming a verdict", async () => {
    await openManage();
    await fireEvent.changeText(
      screen.getByLabelText("Model version label"),
      "v9",
    );
    await fireEvent.press(screen.getByLabelText("Run the harness"));
    expect(mockToasts[0]?.message).toContain("Run queued");
  });

  it("refuses an incomplete golden reference locally", async () => {
    await render(<AiRegressionCard offline={false} canAdmin />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Save a golden reference"));
    await fireEvent.changeText(screen.getByLabelText("Brief"), "a brief");
    await fireEvent.press(screen.getByLabelText("Save reference"));
    expect(mockCapture.mutate).not.toHaveBeenCalled();
    expect(
      screen.getByText(/approved_output must be between 1 and 32000/),
    ).toBeTruthy();
  });

  it("submits a complete reference with a minted lowercase request_id", async () => {
    await render(<AiRegressionCard offline={false} canAdmin />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Save a golden reference"));
    await fireEvent.changeText(screen.getByLabelText("Brief"), "a brief");
    await fireEvent.changeText(
      screen.getByLabelText("Approved output"),
      "the approved copy",
    );
    await fireEvent.press(screen.getByLabelText("Save reference"));
    expect(mockCapture.mutate).toHaveBeenCalledTimes(1);
    const body = mockCapture.mutate.mock.calls[0]?.[0] as {
      surface_kind: string;
      request_id: string;
    };
    expect(body.surface_kind).toBe("campaign_draft");
    expect(body.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
