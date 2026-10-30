/**
 * The APPROVE half of the approval decision bar.
 *
 * `governance-approvals.native.test.tsx` presses Reject and asserts what it
 * does; Approve was only ever asserted to EXIST. That asymmetry matters more
 * than it looks, because the two controls are not symmetric in consequence:
 * rejecting parks the request, approving executes it. `onApprove` is the only
 * decision path on this screen guarded by a confirmation sheet, and a guard
 * that nothing presses is a guard that can be deleted in a refactor without a
 * single test turning red.
 *
 * So these cases pin the whole path, in the order the approver walks it:
 *
 *  1. THE PRESS ASKS FIRST, AND THE ASK NAMES THE CONSEQUENCE. Not "are you
 *     sure" — the sheet has to say the decision is final, that it is recorded
 *     in the audit log, and that the requested action proceeds immediately.
 *  2. DISMISSING IT DECIDES NOTHING. No mutation, no navigation.
 *  3. CONFIRMING POSTS `approve` FOR THIS ID, WITH NO NOTES, and lands the
 *     approver back on the queue they came from.
 *  4. A FAILURE SAYS "APPROVE FAILED" AND KEEPS THEM HERE. The verb is chosen
 *     from the decision; a screen that says "Reject failed" after a failed
 *     approval tells the approver the opposite of what happened.
 *  5. SELF-APPROVAL IS NOT OFFERED AT ALL — the server answers 403
 *     `self_approval`, so the button must be inert AND say why.
 *
 * The decision mutation is the API boundary and is stubbed there (a recorder,
 * so its ARGUMENTS are the assertion). Everything between the press and that
 * boundary — the confirm copy, the gate, the verb, the navigation — is the
 * real screen.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { router } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

import ApprovalDetail from "../app/(tabs)/approvals/[id]";
import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");

/** `router.back` is a jest.fn in the expo-router mock; the real type is void. */
const routerBack = router.back as unknown as { mock: { calls: unknown[][] } };

const REQUESTER_ID = "99999999-9999-4999-8999-999999999999";
const VIEWER_ID = "22222222-2222-4222-8222-222222222222";

const PENDING_APPROVAL = {
  id: "ap-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  resourceType: "campaign",
  resourceId: "c-1",
  requestedByActorType: "user",
  requestedByActorLabel: "grace@example.com",
  requestedByUserId: REQUESTER_ID,
  status: "pending" as const,
  requestedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

/** Every argument the screen handed the decision mutation, in order. */
const decisionCalls: unknown[] = [];
/** When set, the mutation rejects with it — the network-failure branch. */
const decisionFailure: { error: Error | null } = { error: null };

function queryResult(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: async () => ({ data: undefined }),
    dataUpdatedAt: Date.now(),
    ...over,
  };
}

/**
 * Load a pending request that this viewer is allowed to decide.
 *
 * Both approvals screens gate on `canAccessMinimumRole("admin", …)`, so
 * without an owner role every assertion below would silently be a test of the
 * scope notice.
 */
function seedPendingRequest(over: Record<string, unknown> = {}) {
  queryHooks.__setOnlineGateForTests({
    effectiveRole: "owner",
    userId: VIEWER_ID,
    ...over,
  });
  queryHooks.__setHookResultForTests(
    "useApproval",
    queryResult({ data: PENDING_APPROVAL }),
  );
  queryHooks.__setHookResultForTests("useApprovalDecision", {
    isPending: false,
    mutateAsync: async (input: unknown) => {
      decisionCalls.push(input);
      if (decisionFailure.error) throw decisionFailure.error;
      return { ok: true };
    },
  });
}

/**
 * Mounted under the REAL ConfirmProvider and ToastProvider, the way
 * `app/_layout.tsx` mounts them.
 *
 * `useConfirm()` outside a provider resolves TRUE immediately (see
 * ConfirmSheet), so a render without it cannot see the guard at all: deleting
 * the `await confirm(...)` from `onApprove` would leave such a test green.
 */
function renderDetail() {
  return render(React.createElement(ApprovalDetail), {
    wrapper: ({ children }: { children?: React.ReactNode }) => (
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
    ),
  });
}

/**
 * Let React commit what the last interaction queued.
 *
 * Settling the sheet resolves the promise `onApprove` is parked on, and the
 * mutation, the toast and the navigation all land in LATER microtasks — plus
 * the sheet's own commit lands on a macrotask. Without this tick a working
 * approval and a broken one read identically.
 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  decisionCalls.length = 0;
  decisionFailure.error = null;
});

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("approval detail — approving", () => {
  it("asks before approving, and the ask names every consequence", async () => {
    seedPendingRequest();
    const view = await renderDetail();

    await fireEvent.press(view.getByLabelText("Approve this request"));
    await flush();

    // The resource is NAMED, so an approver holding two similar requests can
    // tell which one they are about to execute.
    expect(view.getByText('Approve "Campaign send"?')).toBeTruthy();
    expect(
      view.getByText(
        "This decision is final, cannot be undone, and is recorded in the audit log.",
      ),
    ).toBeTruthy();
    expect(
      view.getByText("The requested action will proceed immediately."),
    ).toBeTruthy();
    // A verb, not "OK".
    expect(view.getByLabelText("Approve")).toBeTruthy();

    // Nothing has been decided yet — the sheet is a gate, not a receipt.
    expect(decisionCalls).toEqual([]);
    expect(routerBack.mock.calls).toHaveLength(0);
  });

  it("decides nothing when the confirm is dismissed", async () => {
    seedPendingRequest();
    const view = await renderDetail();

    await fireEvent.press(view.getByLabelText("Approve this request"));
    await flush();
    await fireEvent.press(view.getByLabelText("Cancel"));
    await flush();

    expect(decisionCalls).toEqual([]);
    expect(routerBack.mock.calls).toHaveLength(0);
    // And the sheet is gone rather than left hanging over the request.
    expect(view.queryByText('Approve "Campaign send"?')).toBeNull();
    // The decision bar is still there: cancelling is not deciding.
    expect(view.getByLabelText("Approve this request")).toBeTruthy();
  });

  it("posts approve for this request — with no notes — and returns to the queue", async () => {
    seedPendingRequest();
    const view = await renderDetail();

    await fireEvent.press(view.getByLabelText("Approve this request"));
    await flush();
    await fireEvent.press(view.getByLabelText("Approve"));
    await flush();

    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0]).toEqual({ id: "ap-1", decision: "approve" });
    // `notes` is the REJECTION's mandatory field. An approve that carries one
    // would be writing a rejection reason into an approval's audit record.
    expect(Object.keys(decisionCalls[0] as object)).not.toContain("notes");
    // The queue is the natural place to land after clearing one.
    expect(routerBack.mock.calls).toHaveLength(1);
  });

  it("says APPROVE failed — not Reject — and keeps the approver on the request", async () => {
    seedPendingRequest();
    decisionFailure.error = new Error("boom");
    const view = await renderDetail();

    await fireEvent.press(view.getByLabelText("Approve this request"));
    await flush();
    await fireEvent.press(view.getByLabelText("Approve"));
    await flush();

    expect(decisionCalls).toHaveLength(1);
    // The verb comes from the decision. "Reject failed" after a failed
    // approval tells the approver the opposite of what happened.
    expect(view.getByText(/^Approve failed\./)).toBeTruthy();
    // No navigation on failure: the request is still pending and still here.
    expect(routerBack.mock.calls).toHaveLength(0);
    expect(view.getByLabelText("Approve this request")).toBeTruthy();
  });

  it("does not offer the decision on the approver's own request", async () => {
    // The server answers 403 `self_approval`, and both ids are already in
    // hand — so this must never reach a confirmation sheet.
    seedPendingRequest({ userId: REQUESTER_ID });
    const view = await renderDetail();

    const approve = view.getByLabelText("Approve this request");
    expect(approve.props.accessibilityState?.disabled).toBe(true);
    expect(
      view.getByText("You requested this, so someone else has to decide it."),
    ).toBeTruthy();

    await fireEvent.press(approve);
    await flush();

    expect(view.queryByText('Approve "Campaign send"?')).toBeNull();
    expect(decisionCalls).toEqual([]);
  });
});
