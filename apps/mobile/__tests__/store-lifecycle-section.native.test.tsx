/**
 * PARITY (commerce-data) — the lifecycle roll-up and its one fan-out write.
 *
 * Four things a "does it render" assertion would never catch:
 *
 *   never on render — `POST .../lifecycle/evaluate` re-checks every
 *                     back-in-stock and price-drop subscription on a store.
 *                     Mounting the section, or switching store, must send
 *                     nothing. Only a confirmed press may.
 *   ask first       — a declined confirm sends nothing, and the confirm has to
 *                     say what will be examined and that eligible ≠ notified.
 *   role            — both routes are admin for a session; a viewer sees no
 *                     section rather than a control that 403s.
 *   verbatim        — `by_status` is the server's own vocabulary. A status this
 *                     build has never seen must still appear with its count.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ToastProvider } from "../src/components/Toast";
import { StoreLifecycleSection } from "../src/components/commerce/StoreLifecycleSection";
import { parseCommerceLifecycleReport } from "../src/lib/commerceLifecycle";

const mockState = {
  confirmAnswer: true,
  confirmCalls: [] as Record<string, unknown>[],
  evaluateCalls: [] as string[],
  evaluateResult: {
    backInStockEligible: 2,
    priceDropEligible: 1,
    evaluatedAt: "2026-09-03T10:05:00Z",
  } as unknown,
  evaluateError: null as unknown,
  reportData: null as unknown,
};

jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => async (options: Record<string, unknown>) => {
    mockState.confirmCalls.push(options);
    return mockState.confirmAnswer;
  },
}));

jest.mock("@/hooks/useCommerceLifecycle", () => ({
  useCommerceLifecycleReport: () => ({
    data: mockState.reportData,
    isError: false,
    isLoading: false,
    isSuccess: true,
    error: null,
    refetch: jest.fn(),
  }),
  useEvaluateCommerceLifecycle: () => ({
    mutateAsync: async (id: string) => {
      mockState.evaluateCalls.push(id);
      if (mockState.evaluateError) throw mockState.evaluateError;
      return mockState.evaluateResult;
    },
    isPending: false,
  }),
}));

const REPORT = {
  integration_id: "int_1",
  generated_at: "2026-09-03T10:00:00Z",
  cart_recovery: { total: 4, by_status: { pending: 3, recovered: 1 } },
  back_in_stock: {
    total: 12,
    by_status: { quarantined_by_a_future_build: 2, waiting: 10 },
  },
  price_drop: { total: 1, by_status: { waiting: 1 } },
  events_last_30_days: { "commerce.back_in_stock.eligible": 2 },
  eligible_last_30_days: 5,
  notified_pending: 2,
};

afterEach(() => {
  mockState.confirmAnswer = true;
  mockState.confirmCalls = [];
  mockState.evaluateCalls = [];
  mockState.evaluateError = null;
  mockState.reportData = null;
});

async function renderSection(
  props: Partial<React.ComponentProps<typeof StoreLifecycleSection>> = {},
) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <StoreLifecycleSection
          integrationId="int_1"
          storeName="acme.myshopify.com"
          gate={{ enabled: true }}
          canAdmin
          {...props}
        />
      </ToastProvider>
    </SafeAreaProvider>,
  );
}

describe("StoreLifecycleSection", () => {
  it("renders the server's own status words and sends nothing on mount", async () => {
    mockState.reportData = parseCommerceLifecycleReport(REPORT);
    await renderSection();

    expect(screen.getByText(/quarantined_by_a_future_build 2/)).toBeTruthy();
    expect(screen.getByText(/Back in stock · 12/)).toBeTruthy();
    expect(
      screen.getByText(/5 became eligible in the last 30 days/),
    ).toBeTruthy();
    expect(mockState.evaluateCalls).toEqual([]);
    expect(mockState.confirmCalls).toEqual([]);
  });

  it("shows nothing at all to a session without the admin role", async () => {
    mockState.reportData = parseCommerceLifecycleReport(REPORT);
    await renderSection({ canAdmin: false });
    expect(screen.queryByText(/Lifecycle demand/)).toBeNull();
    expect(screen.queryByText(/Evaluate eligibility/)).toBeNull();
  });

  it("offers no evaluation offline, because the write is never queued", async () => {
    mockState.reportData = parseCommerceLifecycleReport(REPORT);
    await renderSection({ gate: { enabled: false } });
    expect(screen.queryByText(/Evaluate eligibility…/)).toBeNull();
  });

  it("asks before evaluating, and a declined confirm sends nothing", async () => {
    mockState.reportData = parseCommerceLifecycleReport(REPORT);
    mockState.confirmAnswer = false;
    await renderSection();

    await act(async () => {
      fireEvent.press(screen.getByText("Evaluate eligibility…"));
    });

    expect(mockState.evaluateCalls).toEqual([]);
    expect(mockState.confirmCalls).toHaveLength(1);
    const copy = mockState.confirmCalls[0] as Record<string, string>;
    expect(copy.message).toContain("12 back-in-stock subscriptions");
    expect(copy.consequence).toContain("Eligible is not notified");
  });

  it("sends the confirmed evaluation and reports the server's counters", async () => {
    mockState.reportData = parseCommerceLifecycleReport(REPORT);
    await renderSection();

    await act(async () => {
      fireEvent.press(screen.getByText("Evaluate eligibility…"));
    });

    await waitFor(() => expect(mockState.evaluateCalls).toEqual(["int_1"]));
    // Twice on purpose: the toast announces it, and the card keeps the receipt
    // after the toast has gone.
    expect(
      screen.getAllByText(
        /2 back-in-stock subscriptions and 1 price-drop watcher are now eligible to notify\. Nothing has been sent\./,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("refuses to read a report that belongs to another store", async () => {
    mockState.reportData = parseCommerceLifecycleReport({
      ...REPORT,
      integration_id: "int_other",
    });
    await renderSection();

    expect(screen.getByText(/different store \(int_other\)/)).toBeTruthy();
    expect(screen.queryByText(/Back in stock · 12/)).toBeNull();
    expect(screen.queryByText("Evaluate eligibility…")).toBeNull();
  });
});
