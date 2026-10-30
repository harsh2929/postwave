import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";

/**
 * The 2026-08 desktop-parity ops cluster — the three behaviours that can turn
 * into a live-capacity accident if they regress:
 *
 *  - REPAIR OVERRIDE: releasing the recorded send cap is the screen's 2am
 *    verb. It must exist for an online admin, go through the typed-phrase
 *    confirm, and NEVER be offered below admin or offline (a queued release
 *    lands at a moment nobody chose).
 *  - BREACH FIX CTA: the server-supplied next step must render as a button
 *    when its section has a mobile owner, and render NOTHING for an unknown
 *    slug — a CTA that lands somewhere unrelated is worse than none.
 *  - RETRY TRIAGE: retry evidence is exact-admin because it contains PII;
 *    admins get revision-bound mark-ready/dismiss actions.
 */
const mockClear = {
  mutate: jest.fn(),
  isPending: false,
  reconcile: jest.fn(async () => undefined),
};
const mockRetryQuery: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockSetRetry = { mutate: jest.fn(), isPending: false };
const mockConfirm = jest.fn<(options: unknown) => Promise<boolean>>(
  async () => true,
);
const mockToast = jest.fn();

jest.mock("@/hooks/useDeliverabilityHubOps", () => ({
  useClearRepairOverride: () => mockClear,
  useWebhookErrors: () => ({
    data: undefined,
    isError: false,
    isPending: true,
  }),
}));
jest.mock("@/hooks/useDeliverabilityRecovery", () => ({
  useRetryEvents: () => mockRetryQuery,
  useSetRetryEventStatus: () => mockSetRetry,
}));
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => mockConfirm,
}));
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: mockToast, dismiss: jest.fn() }),
}));

// eslint-disable-next-line import/first
import { router } from "expo-router";

// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import { BreachCard } from "@/components/deliverability/HubSections";
// eslint-disable-next-line import/first
import { IntelligentRetryCard } from "@/components/deliverability/IntelligentRetryCard";
// eslint-disable-next-line import/first
import { RepairOverrideCard } from "@/components/deliverability/RepairOverrideCard";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  mockClear.mutate.mockReset();
  mockClear.reconcile.mockReset();
  mockClear.reconcile.mockResolvedValue(undefined);
  mockToast.mockReset();
  mockSetRetry.mutate.mockReset();
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  (router.push as jest.Mock).mockReset();
  mockRetryQuery.data = undefined;
  mockRetryQuery.isError = false;
});

const THROTTLED = {
  autoThrottled: true,
  autoThrottleReason: "bounce rate above 5%",
};

describe("RepairOverrideCard", () => {
  it("renders nothing at all when the hub is not throttled", async () => {
    const screen = await render(
      <RepairOverrideCard
        hub={{ autoThrottled: false, autoThrottleReason: "" }}
      />,
    );
    expect(screen.toJSON()).toBeNull();
  });

  it("offers the release verb to an online admin, behind the typed confirm", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<RepairOverrideCard hub={THROTTLED} />);
    fireEvent.press(screen.getByText("Review cap restoration"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockConfirm.mock.calls[0]?.[0]).toMatchObject({
      confirmPhrase: "RESTORE SENDING",
      destructive: true,
    });
    await waitFor(() => expect(mockClear.mutate).toHaveBeenCalled());
  });

  it("does not release when the confirm is declined", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockConfirm.mockResolvedValue(false);
    const screen = await render(<RepairOverrideCard hub={THROTTLED} />);
    fireEvent.press(screen.getByText("Review cap restoration"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockClear.mutate).not.toHaveBeenCalled();
  });

  it("holds a committed clear until a canonical repair-state read succeeds", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<RepairOverrideCard hub={THROTTLED} />);
    fireEvent.press(screen.getByText("Review cap restoration"));
    await waitFor(() => expect(mockClear.mutate).toHaveBeenCalledTimes(1));

    const callbacks = mockClear.mutate.mock.calls[0]?.[1] as {
      onSuccess: (outcome: unknown) => void;
    };
    await act(async () => {
      callbacks.onSuccess({
        kind: "committed",
        cleared: true,
        capCoordinationOutcome: "committed",
      });
    });

    expect(
      screen.getByText("Override clear committed; verification pending"),
    ).toBeTruthy();
    expect(screen.queryByText("Review cap restoration")).toBeNull();
    expect(mockClear.mutate).toHaveBeenCalledTimes(1);

    mockClear.reconcile.mockRejectedValueOnce(new Error("read failed"));
    await act(async () => {
      fireEvent.press(screen.getByText("Verify current repair state"));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockClear.reconcile).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText("Override clear committed; verification pending"),
    ).toBeTruthy();
    expect(mockClear.mutate).toHaveBeenCalledTimes(1);
  });

  it("explains instead of offering the verb below admin", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const screen = await render(<RepairOverrideCard hub={THROTTLED} />);
    expect(screen.queryByText("Review cap restoration")).toBeNull();
    expect(screen.getByText(/workspace-admin action/)).toBeTruthy();
  });

  it("does not offer the exact-tenant action to a superadmin alias", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "superadmin" });
    const screen = await render(<RepairOverrideCard hub={THROTTLED} />);
    expect(screen.queryByText("Review cap restoration")).toBeNull();
    expect(screen.getByText(/workspace-admin action/)).toBeTruthy();
    expect(mockClear.mutate).not.toHaveBeenCalled();
  });

  it("explains instead of offering the verb offline — never queued", async () => {
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "owner",
      enabled: false,
    });
    const screen = await render(<RepairOverrideCard hub={THROTTLED} />);
    expect(screen.queryByText("Review cap restoration")).toBeNull();
    expect(screen.getByText(/never queued/)).toBeTruthy();
  });

  it("reports committed-with-fence truthfully and verifies without repeating the POST", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<RepairOverrideCard hub={THROTTLED} />);
    fireEvent.press(screen.getByText("Review cap restoration"));
    await waitFor(() => expect(mockClear.mutate).toHaveBeenCalledTimes(1));

    const callbacks = mockClear.mutate.mock.calls[0]?.[1] as {
      onSuccess: (outcome: unknown) => void;
    };
    await act(async () => {
      callbacks.onSuccess({
        kind: "committed-conservatively-fenced",
        cleared: true,
        capCoordinationOutcome: "committed-conservatively-fenced",
        message:
          "the override was cleared, but sending-cap convergence is still pending",
        requiresReconciliation: true,
      });
    });

    expect(
      screen.getByText("Override cleared; cap convergence is pending"),
    ).toBeTruthy();
    expect(screen.queryByText("Review cap restoration")).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "warning",
        message: expect.stringMatching(/override cleared.*fenced/iu),
      }),
    );

    await act(async () => {
      fireEvent.press(screen.getByText("Verify current repair state"));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockClear.reconcile).toHaveBeenCalledTimes(1));
    expect(mockClear.mutate).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByText("Review cap restoration")).toBeTruthy(),
    );
  });

  it("holds an unknown commit outcome with no success claim or blind retry", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<RepairOverrideCard hub={THROTTLED} />);
    fireEvent.press(screen.getByText("Review cap restoration"));
    await waitFor(() => expect(mockClear.mutate).toHaveBeenCalledTimes(1));

    const callbacks = mockClear.mutate.mock.calls[0]?.[1] as {
      onSuccess: (outcome: unknown) => void;
    };
    await act(async () => {
      callbacks.onSuccess({
        kind: "commit-outcome-unknown",
        cleared: false,
        capCoordinationOutcome: "commit-outcome-unknown-conservatively-fenced",
        message:
          "the database commit outcome could not be proven; sends remain conservatively fenced",
        requiresReconciliation: true,
      });
    });

    expect(
      screen.getByText("Restoration outcome needs verification"),
    ).toBeTruthy();
    expect(screen.getByText(/original POST is held/iu)).toBeTruthy();
    expect(screen.queryByText("Review cap restoration")).toBeNull();
    expect(mockClear.mutate).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "warning",
        message: expect.stringMatching(/could not be proven/iu),
      }),
    );
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "success" }),
    );

    mockClear.reconcile.mockRejectedValueOnce(new Error("verification failed"));
    await act(async () => {
      fireEvent.press(screen.getByText("Verify current repair state"));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockClear.reconcile).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText("Restoration outcome needs verification"),
    ).toBeTruthy();
    expect(screen.queryByText("Review cap restoration")).toBeNull();
    expect(mockClear.mutate).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error" }),
    );

    // Only a later successful read releases the latch. It is still a read:
    // the original POST count cannot move.
    await act(async () => {
      fireEvent.press(screen.getByText("Verify current repair state"));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockClear.reconcile).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByText("Review cap restoration")).toBeTruthy(),
    );
    expect(mockClear.mutate).toHaveBeenCalledTimes(1);
  });

  it("holds an unproven transport/protocol outcome until a separate read", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<RepairOverrideCard hub={THROTTLED} />);
    fireEvent.press(screen.getByText("Review cap restoration"));
    await waitFor(() => expect(mockClear.mutate).toHaveBeenCalledTimes(1));

    const callbacks = mockClear.mutate.mock.calls[0]?.[1] as {
      onSuccess: (outcome: unknown) => void;
    };
    await act(async () => {
      callbacks.onSuccess({
        kind: "outcome-unknown",
        cleared: false,
        message:
          "The repair request did not return a complete outcome receipt.",
        requiresReconciliation: true,
      });
    });

    expect(
      screen.getByText("Restoration outcome needs verification"),
    ).toBeTruthy();
    expect(screen.queryByText("Review cap restoration")).toBeNull();
    expect(mockClear.mutate).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(screen.getByText("Verify current repair state"));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockClear.reconcile).toHaveBeenCalledTimes(1));
    expect(mockClear.mutate).toHaveBeenCalledTimes(1);
  });
});

describe("BreachCard fix CTA", () => {
  const base = {
    code: "bounce_rate",
    severity: "critical",
    title: "Bounce rate above 5%",
    detail: "Clean the list.",
  };

  it("renders the server's fix as a button and routes to the owning tab", async () => {
    const screen = await render(
      <BreachCard
        breach={{ ...base, fixLabel: "Clean list", fixSection: "suppressions" }}
      />,
    );
    fireEvent.press(screen.getByText("Clean list"));
    expect(router.push).toHaveBeenCalledWith("/(tabs)/suppressions");
  });

  it("renders NO button for an unknown section slug", async () => {
    const screen = await render(
      <BreachCard
        breach={{ ...base, fixLabel: "Clean list", fixSection: "mystery" }}
      />,
    );
    expect(screen.queryByText("Clean list")).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("renders no button when the server sent no label", async () => {
    const screen = await render(<BreachCard breach={base} />);
    expect(screen.getByText("Bounce rate above 5%")).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("IntelligentRetryCard", () => {
  const PENDING = [
    {
      id: "ev-1",
      campaignId: "c1",
      subscriberEmail: "held@x.com",
      reason: "soft_bounce",
      status: "pending",
      retryAfter: "2026-08-29T00:00:00Z",
      attempts: 1,
      createdAt: "2026-08-29T00:00:00Z",
      updatedAt: "2026-08-29T00:01:02.123456789Z",
    },
  ];

  it("masks stale retry evidence and every control below exact admin", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockRetryQuery.data = PENDING;
    const screen = await render(<IntelligentRetryCard />);
    expect(
      screen.getByText(/owner or admin access is required/iu),
    ).toBeTruthy();
    expect(screen.queryByText("held@x.com")).toBeNull();
    expect(screen.queryByText("1 actionable")).toBeNull();
    expect(screen.queryByText("Mark ready")).toBeNull();
    expect(screen.queryByText("Dismiss")).toBeNull();
  });

  it("gives an admin both verbs and confirms before a dismiss", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockRetryQuery.data = PENDING;
    const screen = await render(<IntelligentRetryCard />);
    fireEvent.press(screen.getByText("Mark ready"));
    await waitFor(() =>
      expect(mockSetRetry.mutate).toHaveBeenCalledWith(
        {
          id: "ev-1",
          action: "mark-ready",
          expectedUpdatedAt: "2026-08-29T00:01:02.123456789Z",
        },
        expect.anything(),
      ),
    );
    expect(mockConfirm).not.toHaveBeenCalled();
    const markReadyCallbacks = mockSetRetry.mutate.mock.calls[0]?.[1] as {
      onSuccess: () => void;
    };
    await act(async () => markReadyCallbacks.onSuccess());
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "success",
        message: expect.stringMatching(/re-evaluate.*not forced/iu),
      }),
    );

    fireEvent.press(screen.getByText("Dismiss"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockSetRetry.mutate).toHaveBeenCalledWith(
        {
          id: "ev-1",
          action: "dismiss",
          expectedUpdatedAt: "2026-08-29T00:01:02.123456789Z",
        },
        expect.anything(),
      ),
    );
  });

  it("does not expose controls for the undocumented 'held' status alias", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockRetryQuery.data = [{ ...PENDING[0], status: "held" }];
    const screen = await render(<IntelligentRetryCard />);

    expect(screen.getByText("held@x.com")).toBeTruthy();
    expect(screen.queryByText("Mark ready")).toBeNull();
    expect(screen.queryByText("Dismiss")).toBeNull();
    expect(mockSetRetry.mutate).not.toHaveBeenCalled();
  });

  it("offers both recovery decisions for failed rows", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockRetryQuery.data = [{ ...PENDING[0], status: "failed" }];
    const screen = await render(<IntelligentRetryCard />);

    expect(screen.getByText("Mark ready")).toBeTruthy();
    expect(screen.getByText("Dismiss")).toBeTruthy();
  });

  it("offers only dismiss for ready rows because mark-ready is redundant", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockRetryQuery.data = [{ ...PENDING[0], status: "ready" }];
    const screen = await render(<IntelligentRetryCard />);

    expect(screen.queryByText("Mark ready")).toBeNull();
    expect(screen.getByText("Dismiss")).toBeTruthy();
  });

  it("reports a failed queue read as a failure, never an empty queue", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockRetryQuery.isError = true;
    const screen = await render(<IntelligentRetryCard />);
    expect(screen.getByText(/couldn't be loaded/)).toBeTruthy();
    expect(screen.queryByText(/No sends are waiting/)).toBeNull();
  });
});
