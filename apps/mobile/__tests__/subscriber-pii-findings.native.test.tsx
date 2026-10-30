/**
 * SubscriberPiiFindingsCard + PiiFindingDecisionSheet — the Shadow-PII
 * review surface, rendered.
 *
 * The receipt rules and the wire are node-tested; what only a rendered test
 * can pin:
 *  - the Decide verb exists exactly when the session may commit a receipt —
 *    absent (not disabled) otherwise, and never on an already-decided row;
 *  - the decision sheet refuses a half-filled receipt: the mutation must not
 *    fire, and the first unmet requirement is spoken;
 *  - a whole receipt submits with the finding's own updated_at echoed as
 *    expected_updated_at (the server's stale-row guard);
 *  - a 403 on the read renders as the ADMIN RULE, not a generic failure.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import * as QueryGate from "@/hooks/useOnlineQueryGate";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SubscriberPiiFindingsCard } from "@/components/subscriber/sections/SubscriberPiiFindingsCard";
import PiiFindingsScreen from "../app/(tabs)/pii-findings";

// Only the WRITE is stubbed; the read hook runs for real against the suite's
// react-query harness, so the query's own shape stays under test.
jest.mock("@/hooks/useSubscriberPiiFindings", () => {
  const actual = jest.requireActual(
    "@/hooks/useSubscriberPiiFindings",
  ) as Record<string, unknown>;
  const mutate = jest.fn();
  return {
    ...actual,
    __mutate: mutate,
    useReviewPiiFinding: () => ({ isPending: false, error: null, mutate }),
  };
});

const writeHarness = jest.requireMock(
  "@/hooks/useSubscriberPiiFindings",
) as { __mutate: jest.Mock };

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const gateHarness = QueryGate as typeof QueryGate & {
  __setOnlineGateForTests: (value: { effectiveRole: string }) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  writeHarness.__mutate.mockClear();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
});

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

const PENDING_ROW = {
  id: "f-1",
  subscriberId: "sub-9",
  fieldName: "custom_fields.loyalty",
  detectedType: "ssn",
  confidence: 0.93,
  status: "pending",
  createdAt: "2026-08-20T10:00:00Z",
  updatedAt: "2026-08-20T11:22:33Z",
  receipt: null,
};

const DECIDED_ROW = {
  ...PENDING_ROW,
  id: "f-2",
  fieldName: "custom_fields.notes",
  detectedType: "phone",
  status: "dismissed",
  receipt: { reason: "test_data", comment: "Fixture rows." },
};

function prime(result: Record<string, unknown>) {
  queryHarness.__setQueryResultForTests({
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
    ...result,
  });
}

async function drawOpen(canDecide: boolean, result?: Record<string, unknown>) {
  prime(
    result ?? { data: { items: [PENDING_ROW, DECIDED_ROW], total: 2 } },
  );
  await render(
    <SubscriberPiiFindingsCard subscriberId="sub-9" canDecide={canDecide} />,
    { wrapper },
  );
  await act(async () => {
    fireEvent.press(
      screen.getByA11yHint(/Undeclared personal data the scanner found/),
    );
  });
}

describe("PII findings on the subscriber profile", () => {
  it("shows each finding by field + classification, with its receipt when decided", async () => {
    await drawOpen(true);
    expect(screen.getByText("SSN · custom_fields.loyalty")).toBeTruthy();
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(screen.getByText(/Test data — Fixture rows\./)).toBeTruthy();
  });

  it("offers Decide only on the pending row, and never below the receipt floor", async () => {
    await drawOpen(true);
    // One pending row → exactly one Decide verb (the dismissed row is done).
    expect(screen.getAllByText("Decide")).toHaveLength(1);
  });

  it("has NO Decide verb at all when the session cannot commit a receipt", async () => {
    await drawOpen(false);
    expect(screen.queryByText("Decide")).toBeNull();
  });

  it("renders a 403 as the admin rule, not a generic failure", async () => {
    await drawOpen(true, {
      data: undefined,
      error: Object.assign(new Error("forbidden"), { status: 403 }),
      isError: true,
      isSuccess: false,
    });
    expect(
      screen.getByText(/restricted to workspace administrators/),
    ).toBeTruthy();
  });

  it("refuses to record a half-filled receipt", async () => {
    await drawOpen(true);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(/Decide the SSN finding/));
    });
    expect(screen.getByText("Decide this finding")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText("Record decision"));
    });
    expect(writeHarness.__mutate).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Choose why this finding is being confirmed/),
    ).toBeTruthy();
  });

  it("submits a whole receipt echoing the row's updated_at as the stale-row guard", async () => {
    await drawOpen(true);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(/Decide the SSN finding/));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText(/Outcome: Dismissed/));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Reason: False positive"));
    });
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText("Comment"),
        "Store-issued loyalty code, not an SSN.",
      );
    });
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText("Evidence reference"),
        "ticket:DPO-123",
      );
    });
    await act(async () => {
      fireEvent.press(screen.getByText("Record decision"));
    });

    expect(writeHarness.__mutate).toHaveBeenCalledTimes(1);
    const [vars] = writeHarness.__mutate.mock.calls[0] as [
      {
        findingId: string;
        subscriberId: string;
        body: Record<string, string>;
      },
    ];
    expect(vars.findingId).toBe("f-1");
    expect(vars.subscriberId).toBe("sub-9");
    expect(vars.body.status).toBe("dismissed");
    expect(vars.body.reason).toBe("false_positive");
    expect(vars.body.expected_updated_at).toBe("2026-08-20T11:22:33Z");
  });
});

describe("the workspace PII findings route", () => {
  it("loads the native route and renders the privacy-safe admin queue", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    prime({ data: { items: [PENDING_ROW], total: 1 } });

    await render(<PiiFindingsScreen />, { wrapper });

    expect(screen.getByText("PII findings")).toBeTruthy();
    expect(screen.getByText("SSN · custom_fields.loyalty")).toBeTruthy();
    expect(
      screen.queryByText(/matched value|123-45-6789/iu),
    ).toBeNull();
  });
});
