import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";

// RELATIVE, not "@/hooks/useApprovals": that alias is mapped to
// __tests__/mocks/queryHooks.cjs, which answers `useApprovalDecision` with an
// inert mutation stub. Importing by path bypasses the mapper so the REAL
// mutation config runs; everything it depends on (the react-query transport,
// the API client, the online gate) is still mocked, which is exactly the shape
// this test needs.
import { useApprovalDecision } from "../src/hooks/useApprovals";

const reactQuery = require("./mocks/reactQuery.cjs");

/**
 * THE DECIDED ROW HAS TO LEAVE THE QUEUE.
 *
 * governance-approvals.native.test.tsx pins what the approvals screens RENDER.
 * This file pins the one behaviour underneath them that a wrong tap depends on
 * and that no render test can see: after a decision, the pending list must be
 * refetched, so an approver never sees a row they already signed off — and
 * taps it again.
 *
 * The interesting half is the FAILURE path. `useApprovalDecision.onError` calls
 * `isStaleDecisionError`, and the distinction it draws is load-bearing:
 *
 *   409 not_pending / 410 expired / 404 gone
 *       → the SERVER's copy has moved on and ours is stale. Refetch. The user's
 *         own earlier attempt on a flaky network is the commonest cause, so the
 *         list has to catch up or they will keep tapping a row that is gone.
 *   403 self_approval / admin_required
 *       → the row is still exactly as we have it; we are simply not allowed to
 *         decide it. Refetching would be a pointless request that also blanks
 *         the queue the user is reading.
 *
 * `useOnlineQueryGate` is the shared mock, whose tenant id is the constant
 * below — the invalidation must be scoped to it, because an unscoped
 * ["approvals"] key would cross tenant boundaries on a workspace switch.
 */

const GATE_TENANT = "11111111-1111-4111-8111-111111111111";
const APPROVALS_KEY = { queryKey: ["approvals", GATE_TENANT] };

async function mountDecisionMutation() {
  function Harness() {
    useApprovalDecision();
    return null;
  }
  // AWAITED. React 19's concurrent root does not commit inside a synchronous
  // `render()` here, so reading the captured options without awaiting reads
  // them before the component has ever run.
  await render(React.createElement(Harness));
  const options = reactQuery.__getLastMutationOptionsForTests();
  // Fail loudly rather than passing vacuously: if the hook stopped reaching
  // useMutation, every assertion below would silently test nothing.
  expect(options).toBeTruthy();
  return options as {
    onSuccess: () => void;
    onError: (error: unknown) => void;
  };
}

interface InvalidateSpy {
  (options: { queryKey: unknown[] }): unknown;
  mock: { calls: unknown[][] };
  mockClear: () => void;
}

function queryClientMock() {
  return reactQuery.useQueryClient() as { invalidateQueries: InvalidateSpy };
}

describe("approval decision cache policy", () => {
  it("refetches the pending queue after a decision commits", async () => {
    const options = await mountDecisionMutation();
    const client = queryClientMock();
    client.invalidateQueries.mockClear();

    options.onSuccess();

    // Scoped to the tenant: a bare ["approvals"] key would also drop the
    // previous workspace's queue on a switch.
    expect(client.invalidateQueries).toHaveBeenCalledWith(APPROVALS_KEY);
  });

  it.each([
    ["409 already decided", 409],
    ["410 expired", 410],
    ["404 removed", 404],
  ])("refreshes the list on a %s conflict", async (_label, status) => {
    const options = await mountDecisionMutation();
    const client = queryClientMock();
    client.invalidateQueries.mockClear();

    options.onError({ status });

    expect(client.invalidateQueries).toHaveBeenCalledWith(APPROVALS_KEY);
  });

  it.each([
    ["403 self-approval", 403],
    ["500 server error", 500],
    ["network failure", undefined],
  ])("leaves the queue alone on a %s", async (_label, status) => {
    const options = await mountDecisionMutation();
    const client = queryClientMock();
    client.invalidateQueries.mockClear();

    options.onError(status === undefined ? new Error("offline") : { status });

    // Nothing about our cached copy is known to be wrong, and blanking the
    // queue the approver is reading is a worse answer than the error toast.
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });
});
