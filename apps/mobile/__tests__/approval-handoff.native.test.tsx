/**
 * SHELL#31 — the approval detail screen donates its NSUserActivity.
 *
 * `ENTITY_ACTIVITY_DISCLOSURE` (src/lib/entityActivity.ts) has listed
 * `approval: { handoff: true, spotlight: false }` since the policy module was
 * written, and `entityActivity.test.ts` asserts the table's shape — but no
 * screen ever called the bridge for an approval, so the rule described nothing
 * that happened. Campaigns, sequences and subscribers all donated; the one
 * entity whose whole value is "finish this on the bigger screen" did not.
 *
 * What is pinned here is the pair of facts that make the donation safe, not
 * just the fact that it happens:
 *   - HANDOFF YES, SPOTLIGHT NO, and no keywords. A pending decision is
 *     ephemeral and may be revoked; a search index entry outlives sign-out.
 *   - NOT DONATED AT ALL for a viewer who may not read the request, or while
 *     the app lock is armed.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

// `jest.mock` is hoisted above every import by babel-plugin-jest-hoist, so the
// screen below still loads against the two mocks declared underneath it.
import ApprovalDetail from "../app/(tabs)/approvals/[id]";

jest.mock("@/lib/entityActivityBridge", () => ({
  donateEntityActivity: jest.fn(() => true),
  suspendEntityActivity: jest.fn(),
  purgeEntityActivities: jest.fn(async () => undefined),
}));
jest.mock("@/lib/biometric", () => ({
  getBiometricLockEnabled: jest.fn(async () => false),
  subscribeBiometricLockPreference: jest.fn(() => () => undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const queryHooks = require("./mocks/queryHooks.cjs");
const bridge = require("@/lib/entityActivityBridge") as any;
const biometric = require("@/lib/biometric") as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// The id expoRouter.cjs answers `useLocalSearchParams` with.
const ROUTE_ID = "11111111-1111-4111-8111-111111111111";

const PENDING_APPROVAL = {
  id: ROUTE_ID,
  tenantId: "22222222-2222-4222-8222-222222222222",
  resourceType: "campaign",
  resourceId: "c-1",
  requestedByActorType: "user",
  requestedByActorLabel: "grace@example.com",
  requestedByUserId: "99999999-9999-4999-8999-999999999999",
  status: "pending" as const,
  requestedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function queryResult(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
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

async function renderScreen() {
  return await render(React.createElement(ApprovalDetail), {
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

/** The one donation the screen made, or null. */
function donated(): Record<string, unknown> | null {
  const calls = bridge.donateEntityActivity.mock.calls;
  return calls.length ? (calls[0][0] as Record<string, unknown>) : null;
}

beforeEach(() => {
  // `clearMocks` wipes calls, not the assignments a previous test made.
  biometric.getBiometricLockEnabled = jest.fn(async () => false);
  biometric.subscribeBiometricLockPreference = jest.fn(() => () => undefined);
  queryHooks.__setHookResultForTests(
    "useApproval",
    queryResult({ data: PENDING_APPROVAL }),
  );
});

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("SHELL#31 — an approval is handed off, never indexed", () => {
  it("donates the open request to Handoff with no search index entry", async () => {
    queryHooks.__setOnlineGateForTests({ effectiveRole: "owner" });
    await renderScreen();
    // The app-lock read resolves asynchronously and the donation effect runs
    // on the render that follows it.
    await act(async () => undefined);

    const activity = donated();
    expect(activity).not.toBeNull();
    // Keyed by entity+id, so the same request opened from the queue, a push and
    // a deep link is ONE activity rather than three.
    expect(activity?.id).toBe(`postwave.entity.approval.${ROUTE_ID}`);
    expect(activity?.isEligibleForHandoff).toBe(true);
    // The half that matters: Spotlight survives sign-out, a decision does not.
    expect(activity?.isEligibleForSearch).toBe(false);
    expect(activity?.keywords).toEqual([]);
    // Never the raw id — an opaque identifier in the Dock tells the reader
    // nothing and tells everyone else that the record exists.
    expect(activity?.title).not.toBe(ROUTE_ID);
    expect(String(activity?.title).length).toBeGreaterThan(0);
  });

  it("donates nothing for a viewer who may not read the request", async () => {
    // A VIEWER, stated explicitly. The shared gate mock's default identity is
    // an OWNER (queryHooks.cjs OPEN_GATE), so leaving the role unset renders
    // the fully-privileged screen and asserts nothing about the denial branch.
    // The screen renders the admin-only notice instead of the request, and
    // must not put its existence on another device either.
    queryHooks.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const result = await renderScreen();
    await act(async () => undefined);

    // Proof the branch was actually taken, not that the screen failed to
    // render: this is the admin-only notice, in place of the request.
    expect(result.getByText("Approvals need an admin role")).toBeTruthy();
    expect(bridge.donateEntityActivity).not.toHaveBeenCalled();
  });

  it("donates nothing while the app lock is armed", async () => {
    queryHooks.__setOnlineGateForTests({ effectiveRole: "owner" });
    biometric.getBiometricLockEnabled = jest.fn(async () => true);
    const result = await renderScreen();
    await act(async () => undefined);

    // Same request, same role, same everything the previous test had — the
    // lock is the only difference, so this cannot pass by the screen simply
    // not loading.
    expect(result.getByLabelText("Approve this request")).toBeTruthy();
    expect(bridge.donateEntityActivity).not.toHaveBeenCalled();
  });
});
