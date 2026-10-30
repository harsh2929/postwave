/**
 * Spend controls — the render contract for the card that stops the meter.
 *
 * WHY THIS FILE EXISTS. `app/(tabs)/billing.tsx` has no render test, so
 * `SpendControlsCard` shipped having never been mounted by anything. Its 37
 * policy tests in `lib/spendControls.test.ts` prove the sentences are right;
 * they cannot prove the card survives being opened, and in this programme that
 * distinction has already cost a crashed dashboard.
 *
 * The card is driven DIRECTLY rather than through the billing screen. The
 * `@tanstack/react-query` harness sets ONE result for every `useQuery` in the
 * module graph, so rendering the whole screen would hand the plan summary, the
 * invoice list, the usage series and the sending add-on the same payload — the
 * mock-shape mismatch that makes a suite pass while asserting nothing.
 *
 * WHAT THIS PROTECTS. Every assertion is about a money sentence being WRONG
 * rather than a card being blank:
 *
 *   - claiming sends are "being billed as overage" when Stripe metered billing
 *     is unconfigured invents a charge that cannot happen;
 *   - rendering "overage is on" while the ceiling has been reached hides that
 *     sends are being REFUSED, which is the opposite of what the operator needs;
 *   - showing the switch to a non-admin offers a control that can only 403.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SpendControlsCard } from "@/components/billing/SpendControlsCard";
import * as Gate from "@/hooks/useOnlineQueryGate";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetOnlineGateForTests();
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

/** The `sendingAddon` block as `toDashboardState` marshals it. */
function addon(overrides: Record<string, unknown> = {}) {
  return {
    monthlyCap: 100_000,
    used: 40_000,
    daysRemaining: 12,
    overageEnabled: false,
    overageUnits: 0,
    overageChargeable: false,
    overageBillingConfigured: false,
    ...overrides,
  };
}

function settled(value: unknown) {
  return {
    data: value,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: value })),
  };
}

function online(role = "admin") {
  hookHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: role,
    online: true,
  });
}

describe("spend controls render contract", () => {
  it("mounts at all", async () => {
    // The assertion this file is really for: nothing had ever rendered this.
    online();
    queryHarness.__setQueryResultForTests(settled(addon()));
    await render(<SpendControlsCard />, { wrapper });
    expect(screen.getByText("Spend controls")).toBeTruthy();
  });

  it("never claims a charge when metered billing is unconfigured", async () => {
    // The self-host case. "Being billed" here would invent a charge that
    // cannot happen.
    online();
    queryHarness.__setQueryResultForTests(
      settled(addon({ overageEnabled: true, overageUnits: 2_500 })),
    );
    await render(<SpendControlsCard />, { wrapper });
    expect(screen.getByText(/nothing is being charged/u)).toBeTruthy();
    expect(screen.queryByText(/being billed as overage/u)).toBeNull();
  });

  it("says sends are REFUSED once the ceiling is reached", async () => {
    // Rendering this as "overage is on" would tell the operator the opposite
    // of what is happening to their sends.
    online();
    queryHarness.__setQueryResultForTests(
      settled(
        addon({
          overageEnabled: true,
          overageChargeable: true,
          overageBillingConfigured: true,
          overageUnits: 1_000,
          overageCap: 1_000,
        }),
      ),
    );
    await render(<SpendControlsCard />, { wrapper });
    expect(screen.getByText(/refused/u)).toBeTruthy();
  });

  it("offers no controls below admin, but still shows the state", async () => {
    // Knowing money is being spent is worth having even when changing it is
    // not yours to do.
    online("viewer");
    queryHarness.__setQueryResultForTests(settled(addon()));
    await render(<SpendControlsCard />, { wrapper });
    expect(screen.getByText("Spend controls")).toBeTruthy();
    expect(screen.queryByText("Allow sending past the plan cap")).toBeNull();
  });

  it("shows the structural SMS ledger hold when there is no metered plan", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled(null));
    await render(<SpendControlsCard />, { wrapper });
    expect(screen.getByText("Spend controls")).toBeTruthy();
    expect(screen.getByText("SMS financial ledger release-held")).toBeTruthy();
    expect(
      screen.getByText(/Balance, usage, purchased credits, and entitlement/u),
    ).toBeTruthy();
    expect(screen.queryByText(/SMS credits available/u)).toBeNull();
  });

  it("keeps the raw gate code out of what the operator reads", async () => {
    // This test used to assert the OPPOSITE — that the sentence printed
    // `sms_financial_ledger_release_held` verbatim. It is a server-side
    // identifier an operator cannot act on, and it sat inside an otherwise
    // plain-English sentence. The sentence stays; the parenthesis goes.
    online();
    queryHarness.__setQueryResultForTests(settled(null));
    await render(<SpendControlsCard />, { wrapper });

    expect(screen.queryByText(/sms_financial_ledger_release_held/u)).toBeNull();
    // The code is still reachable for support — as a diagnostic handle on the
    // notice, which is never rendered to a reader or spoken by VoiceOver.
    expect(
      screen.getByTestId("spend-controls-hold-sms_financial_ledger_release_held"),
    ).toBeTruthy();
  });

  it("does not crash on a wire payload missing every field", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled({}));
    expect(() => render(<SpendControlsCard />, { wrapper })).not.toThrow();
  });
});
