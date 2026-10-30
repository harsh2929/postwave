import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Audit from "../app/(tabs)/audit";
import Approvals from "../app/(tabs)/approvals";
import ApprovalDetail from "../app/(tabs)/approvals/[id]";
// The same exports object the screen reads through, so a spy here is the
// clock the screen actually calls.
import * as TickingNow from "@/hooks/useTickingNow";

const queryHooks = require("./mocks/queryHooks.cjs");
const reactQuery = require("./mocks/reactQuery.cjs");
const expoRouter = require("./mocks/expoRouter.cjs");

// Focus is a per-test fact here, not a constant: the route mock answers `true`
// forever, which is exactly the condition under which a visited-but-blurred
// tab polling in the background is invisible. Boxed so the hoisted factory can
// read it (jest lets only `mock`-prefixed names through the hoist).
const mockFocus = { value: true };
jest.mock("expo-router", () => ({
  ...(jest.requireActual("expo-router") as Record<string, unknown>),
  useIsFocused: () => mockFocus.value,
}));

/**
 * The behaviours a WRONG TAP on a governance screen depends on.
 *
 * governance.native.test.tsx already pins the audit log's five-state ladder.
 * This file covers the half that decides something:
 *
 *  1. A FAILED APPROVALS FETCH IS NOT AN EMPTY QUEUE. "You're caught up" over
 *     a 500 tells an approver there is nothing to sign off. It must be an
 *     error with a retry.
 *  2. A REJECTION WITHOUT A REASON IS BLOCKED CLIENT-SIDE. The server answers
 *     400 `reason_required`; a submit button that reaches it is a button that
 *     teaches the user their input was fine and the product is broken.
 *  3. THE CHAIN ANSWERS "AM I THE BLOCKER?". The whole point of the surface.
 *  4. APPROVING AN INVESTIGATION IS NOT EXECUTING IT. The single most
 *     consequential sentence in the audit cluster, and the one a redesign is
 *     most likely to drop as "noise".
 *  5. A FAILED SAVED-VIEW LIST IS NOT "YOU HAVE NO SAVED VIEWS". On a
 *     compliance surface that reads as data loss.
 *
 * Every mocked payload is the hook's REAL return shape. `useApprovalChain`,
 * `useAuditSavedViews` and `useAuditInvestigations` are NOT in the
 * queryHooks module map, so they resolve for real and read the global
 * `@tanstack/react-query` mock — which is exactly why the chain assertions
 * below are genuine (they exercise buildApprovalChainView, not a stub).
 */

function queryResult(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    hasNextPage: false,
    fetchNextPage: async () => undefined,
    refetch: async () => ({ data: undefined }),
    dataUpdatedAt: Date.now(),
    ...over,
  };
}

function auditPages(rows: unknown[], over: Record<string, unknown> = {}) {
  return queryResult({
    data: { pages: [{ rows, nextCursor: null }], pageParams: [null] },
    ...over,
  });
}

const LOGIN_ROW = {
  id: 501,
  action: "user.login",
  resourceType: "user",
  resourceId: "u-1",
  actorType: "user",
  actorLabel: "ada@example.com",
  metadata: {},
  at: new Date().toISOString(),
};

const SEND_ROW = {
  id: 502,
  action: "campaign.send",
  resourceType: "campaign",
  resourceId: "c-1",
  actorType: "user",
  actorLabel: "grace@example.com",
  metadata: {},
  at: new Date().toISOString(),
};

const PENDING_APPROVAL = {
  id: "ap-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  resourceType: "campaign",
  resourceId: "c-1",
  requestedByActorType: "user",
  requestedByActorLabel: "grace@example.com",
  requestedByUserId: "99999999-9999-4999-8999-999999999999",
  status: "pending" as const,
  requestedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function renderScreen(Component: React.ComponentType) {
  return render(React.createElement(Component), {
    wrapper: ({ children }: { children?: React.ReactNode }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  reactQuery.__resetQueryResultForTests();
});

describe("audit security lens", () => {
  it("narrows to the security slice and drops everything else", async () => {
    queryHooks.__setHookResultForTests(
      "useAuditLog",
      auditPages([LOGIN_ROW, SEND_ROW]),
    );
    const result = await renderScreen(Audit);

    expect(result.getByText("Signed in")).toBeTruthy();
    expect(result.getByText("Campaign sent")).toBeTruthy();

    await fireEvent.press(
      result.getByLabelText(
        "Show only security actions: sign-in, MFA, tokens, roles and devices",
      ),
    );

    expect(result.getByText("Signed in")).toBeTruthy();
    // A send is not a security event; the lens must actually exclude it,
    // otherwise the named lens is decoration over an unfiltered list.
    expect(result.queryByText("Campaign sent")).toBeNull();
  });

  it("says the live tail is a poll, never implying a stream", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([LOGIN_ROW]));
    const result = await renderScreen(Audit);

    await fireEvent.press(
      result.getByLabelText("Check for new events automatically"),
    );
    // RN fetch cannot stream. An operator who thinks they are watching a live
    // feed reads a quiet twenty seconds as "nothing happened".
    expect(result.getByText(/Checking for new events every 20s/)).toBeTruthy();
    expect(result.getByText(/counted, not inserted/)).toBeTruthy();
  });
});

describe("audit saved views", () => {
  it("says the list is unavailable rather than rendering an empty bar", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([LOGIN_ROW]));
    reactQuery.__setQueryResultForTests(
      queryResult({
        isError: true,
        error: new Error("boom"),
        isSuccess: false,
      }),
    );
    const result = await renderScreen(Audit);

    expect(
      result.getByText("Saved views are unavailable right now."),
    ).toBeTruthy();
    // The Save affordance goes with it: saving into a list we cannot read
    // invites silent duplicates.
    expect(
      result.queryByLabelText("Save the current filters as a named view"),
    ).toBeNull();
  });
});

describe("audit investigations", () => {
  it("never offers an approve button without saying Moosewave will not execute it", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([LOGIN_ROW]));
    queryHooks.__setHookResultForTests(
      "useAuditScopes",
      queryResult({
        data: { scopes: [], auditScopes: ["audit:read"], isAdmin: true },
      }),
    );
    reactQuery.__setQueryResultForTests(
      queryResult({
        data: [
          {
            id: "inv-1",
            seed_audit_id: 501,
            status: "draft",
            findings: [],
            evidence_audit_ids: [],
            proposed_actions: [],
            mitre_techniques: [],
            confidence: 0,
          },
        ],
      }),
    );
    const result = await renderScreen(Audit);

    await fireEvent.press(
      result.getByLabelText("AI investigations, 1 awaiting review"),
    );

    expect(result.getByLabelText("Approve this remediation plan")).toBeTruthy();
    expect(
      result.getByText(/does NOT apply these account changes/),
    ).toBeTruthy();
  });

  it("withholds the decision buttons from a reader who is not an admin", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([LOGIN_ROW]));
    // audit:read WITHOUT admin: the decide routes are gated on
    // apikeys.ScopeAdmin, so the queue must render and the buttons must not.
    queryHooks.__setHookResultForTests(
      "useAuditScopes",
      queryResult({
        data: { scopes: [], auditScopes: ["audit:read"], isAdmin: false },
      }),
    );
    reactQuery.__setQueryResultForTests(
      queryResult({
        data: [
          {
            id: "inv-1",
            seed_audit_id: 501,
            status: "draft",
            findings: [],
            evidence_audit_ids: [],
            proposed_actions: [],
            mitre_techniques: [],
            confidence: 0,
          },
        ],
      }),
    );
    const result = await renderScreen(Audit);

    await fireEvent.press(
      result.getByLabelText("AI investigations, 1 awaiting review"),
    );

    expect(result.queryByLabelText("Approve this remediation plan")).toBeNull();
    expect(
      result.getByText(
        "Deciding an investigation is limited to workspace owners and admins.",
      ),
    ).toBeTruthy();
  });
});

/**
 * Both approvals screens gate on `canAccessMinimumRole("admin", gate
 * .effectiveRole, mode)` — GET /api/v1/approvals is owner/admin-only
 * (requireAdmin in approvals/handlers.go). The shared gate mock does not carry
 * a role, so without this the screens render their scope notice and every
 * assertion below would be a test of the 403 branch.
 */
function asOwner() {
  queryHooks.__setOnlineGateForTests({ effectiveRole: "owner" });
}

describe("approvals queue", () => {
  it("shows an error with a retry — NOT 'You're caught up' — when the fetch fails", async () => {
    asOwner();
    queryHooks.__setHookResultForTests(
      "usePendingApprovals",
      queryResult({
        isError: true,
        error: new Error("boom"),
        isSuccess: false,
      }),
    );
    const result = await renderScreen(Approvals);

    expect(result.queryByText("You're caught up")).toBeNull();
    expect(result.getByLabelText("Retry")).toBeTruthy();
  });

  it("says the queue is empty only when the fetch actually succeeded", async () => {
    asOwner();
    queryHooks.__setHookResultForTests(
      "usePendingApprovals",
      queryResult({ data: [] }),
    );
    const result = await renderScreen(Approvals);

    expect(result.getByText("You're caught up")).toBeTruthy();
    expect(result.queryByLabelText("Retry")).toBeNull();
  });
});

/**
 * PERF-1 — Expo Router keeps a visited tab MOUNTED, so everything this screen
 * starts on mount keeps running after the approver walks away from it.
 *
 * `usePendingApprovals` polls at 60s on the same cache key the tab badge polls
 * at 5 minutes, and the shortest mounted observer wins: one visit used to pin
 * the badge key to 60s for the rest of the session (10 GETs per 10 minutes
 * instead of 2). The 1s expiry clock re-rendered the hidden tree once a second
 * too. Both now take the screen's focus, so a blurred tab asks for neither.
 */
describe("approvals queue follows the tab's focus", () => {
  afterEach(() => {
    mockFocus.value = true;
  });

  function lastPendingEnabled(): unknown {
    return queryHooks.__getHookCallsForTests("usePendingApprovals").at(-1)?.[0];
  }

  it("disables the 60-second pending poll and the 1s clock while the tab is blurred", async () => {
    asOwner();
    const clock = jest.spyOn(TickingNow, "useTickingNow");
    queryHooks.__setHookResultForTests(
      "usePendingApprovals",
      queryResult({ data: [] }),
    );
    mockFocus.value = false;
    await renderScreen(Approvals);

    expect(lastPendingEnabled()).toBe(false);
    expect(clock).toHaveBeenCalled();
    expect(clock.mock.calls.at(-1)?.[0]).toBe(false);
  });

  it("keeps the queue live and the clock ticking while the tab is focused", async () => {
    asOwner();
    const clock = jest.spyOn(TickingNow, "useTickingNow");
    queryHooks.__setHookResultForTests(
      "usePendingApprovals",
      queryResult({ data: [] }),
    );
    const result = await renderScreen(Approvals);

    expect(lastPendingEnabled()).toBe(true);
    expect(clock.mock.calls.at(-1)?.[0]).toBe(true);
    expect(result.getByText("You're caught up")).toBeTruthy();
  });
});

describe("approvals history slicing", () => {
  const DECIDED = (
    id: string,
    status: "approved" | "rejected",
    requester: string,
  ) => ({
    ...PENDING_APPROVAL,
    id,
    status,
    requestedByActorLabel: requester,
    decidedAt: new Date().toISOString(),
  });

  it("narrows the All window to one resolved state from the status chips", async () => {
    asOwner();
    queryHooks.__setHookResultForTests(
      "usePendingApprovals",
      queryResult({ data: [] }),
    );
    queryHooks.__setHookResultForTests(
      "useAllApprovals",
      queryResult({
        data: [
          DECIDED("ap-a", "approved", "approved-req@example.com"),
          DECIDED("ap-r", "rejected", "rejected-req@example.com"),
        ],
      }),
    );
    const result = await renderScreen(Approvals);

    // The status chips exist only once the All window is active.
    expect(result.queryByText("Any status")).toBeNull();
    await fireEvent.press(result.getByText("All"));
    expect(result.getByText("Requested by approved-req@example.com")).toBeTruthy();
    expect(result.getByText("Requested by rejected-req@example.com")).toBeTruthy();

    await fireEvent.press(result.getByText("Rejected"));
    expect(result.queryByText("Requested by approved-req@example.com")).toBeNull();
    expect(result.getByText("Requested by rejected-req@example.com")).toBeTruthy();

    // The sort control is offered too (ordering itself is pinned in the
    // node tests over sortApprovals).
    expect(result.getByText("Sort: Newest")).toBeTruthy();
    expect(result.getByText("Oldest")).toBeTruthy();
  });
});

describe("approval detail", () => {
  it("blocks a rejection with no reason instead of letting the server 400", async () => {
    asOwner();
    queryHooks.__setHookResultForTests(
      "useApproval",
      queryResult({ data: PENDING_APPROVAL }),
    );
    const result = await renderScreen(ApprovalDetail);

    await fireEvent.press(result.getByLabelText("Reject this request"));
    const submit = result.getByLabelText("Reject approval");
    expect(submit.props.accessibilityState?.disabled).toBe(true);
  });

  it("answers 'am I the blocker?' with the stage the chain is waiting on", async () => {
    asOwner();
    queryHooks.__setHookResultForTests(
      "useApproval",
      queryResult({ data: PENDING_APPROVAL }),
    );
    // One global useQuery answer feeds BOTH chain reads — the config and the
    // progress — which is exactly the merge buildApprovalChainView performs.
    reactQuery.__setQueryResultForTests(
      queryResult({
        data: {
          steps: [
            { position: 1, role: "editor" },
            { position: 2, role: "legal" },
          ],
          stages: [
            { position: 1, role: "editor", status: "approved" },
            { position: 2, role: "legal", status: "pending" },
          ],
          state: "pending",
          current_position: 2,
        },
      }),
    );
    const result = await renderScreen(ApprovalDetail);

    expect(
      result.getByText(
        "Stage 2 of 2 — waiting on Legal. 1 stage ahead already approved.",
      ),
    ).toBeTruthy();
    // State is spoken, never colour-alone.
    expect(result.getByLabelText("Stage 1, Editor: approved")).toBeTruthy();
    expect(result.getByLabelText("Stage 2, Legal: waiting now")).toBeTruthy();
  });
});

/**
 * GOVERNANCE#37 — the OTHER end of "a rejection always carries a reason".
 *
 * `usePushResponseRouting` refuses to POST a reasonless reject from a
 * notification button and instead navigates here with `reject=1`. That contract
 * is worth nothing unless this screen actually opens the sheet on arrival: an
 * approver who tapped Reject and landed on a read-only detail view would simply
 * have lost the action, which is a worse outcome than the bug being fixed.
 */
describe("approval detail — reject handoff from a notification action", () => {
  afterEach(() => {
    expoRouter.__setSearchParamsForTests({});
  });

  it("opens the mandatory-reason sheet when routed with reject=1", async () => {
    asOwner();
    expoRouter.__setSearchParamsForTests({ reject: "1" });
    queryHooks.__setHookResultForTests(
      "useApproval",
      queryResult({ data: PENDING_APPROVAL }),
    );
    const result = await renderScreen(ApprovalDetail);

    // The sheet is up without anyone pressing Reject on this screen, and its
    // submit is disabled — the reason is still required, which is the point.
    const submit = result.getByLabelText("Reject approval");
    expect(submit.props.accessibilityState?.disabled).toBe(true);
  });

  it("does not open it on an ordinary visit", async () => {
    asOwner();
    queryHooks.__setHookResultForTests(
      "useApproval",
      queryResult({ data: PENDING_APPROVAL }),
    );
    const result = await renderScreen(ApprovalDetail);

    expect(result.queryByLabelText("Reject approval")).toBeNull();
  });

  it("does not open it for a request that is no longer pending", async () => {
    // Nothing to reject: the decision bar is gone, so a sheet floating over a
    // decided request would be an action that cannot complete.
    asOwner();
    expoRouter.__setSearchParamsForTests({ reject: "1" });
    queryHooks.__setHookResultForTests(
      "useApproval",
      queryResult({ data: { ...PENDING_APPROVAL, status: "approved" } }),
    );
    const result = await renderScreen(ApprovalDetail);

    expect(result.queryByLabelText("Reject approval")).toBeNull();
  });
});
