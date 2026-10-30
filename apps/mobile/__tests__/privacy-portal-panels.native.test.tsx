/**
 * The privacy-portal operator surface on the Compliance screen: regions
 * matrix add/remove, the double opt-in pending queue's extend/cancel, and
 * the wiring of the new evidence panels into the screen itself.
 *
 * What these tests pin, and why:
 *  - LOCAL REFUSAL FIRST — a region draft the server would 400 never leaves
 *    the phone.
 *  - THE CONFIRM IS PART OF THE VERB — cancel is destructive and extend
 *    carries the honest "does not directly send mail" copy; a mutate that
 *    fires without its confirm is a defect, not a shortcut.
 *  - SCREEN WIRING — the sections actually render from
 *    CompliancePostureScreen for an admin; unwiring any of them fails here,
 *    not in production.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CompliancePostureScreen } from "../src/components/compliance/CompliancePostureScreen";
import { DoubleOptinQueueCard } from "../src/components/compliance/DoubleOptinQueueCard";
import { RegionsMatrixCard } from "../src/components/compliance/RegionsMatrixCard";
import { ToastProvider } from "../src/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useCompliance", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/usePrivacyPortalOps", () =>
  require("./mocks/queryHooks.cjs"),
);
jest.mock("@/hooks/useComplianceEvidence", () =>
  require("./mocks/queryHooks.cjs"),
);

// The confirm sheet, controllable: resolves the queued answer and records
// what the operator was actually asked.
const mockConfirmCalls: Record<string, unknown>[] = [];
let mockConfirmAnswer = true;
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => async (options: Record<string, unknown>) => {
    mockConfirmCalls.push(options);
    return mockConfirmAnswer;
  },
}));

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function mutationResult(mutate: unknown) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    mutate,
    mutateAsync: jest.fn(async () => ({})),
    reset: jest.fn(),
    variables: undefined,
  };
}

function renderInApp(element: React.ReactElement) {
  return render(<ToastProvider>{element}</ToastProvider>, {
    wrapper: ({ children }) => (
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

const PENDING_ROW = {
  id: "p-1",
  email: "stuck@example.com",
  listId: "7",
  sentAt: "2026-08-01T09:00:00Z",
  expiresAt: "2026-09-30T09:00:00Z",
};

const REGION_ROW = {
  id: "r-1",
  regionCode: "EU",
  framework: "gdpr",
  requiresDoubleOptIn: true,
  requiresExplicitConsent: true,
  doNotSellDefault: false,
  gpcHonored: false,
};

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
  mockConfirmCalls.length = 0;
  mockConfirmAnswer = true;
});

describe("double opt-in pending queue", () => {
  it("extends through a confirm that never claims an email was sent", async () => {
    const mutate = jest.fn();
    queryHooks.__setHookResultForTests(
      "useExtendDoubleOptin",
      mutationResult(mutate),
    );
    queryHooks.__setHookResultForTests(
      "useCancelDoubleOptin",
      mutationResult(jest.fn()),
    );
    const result = await renderInApp(
      <DoubleOptinQueueCard
        rows={[PENDING_ROW]}
        truncated={false}
        now={Date.parse("2026-08-29T12:00:00Z")}
      />,
    );
    await fireEvent.press(
      result.getByLabelText(
        "Extend the confirmation window for stuck@example.com",
      ),
    );
    // The async confirm resolves on the microtask queue.
    await Promise.resolve();
    expect(mockConfirmCalls).toHaveLength(1);
    expect(String(mockConfirmCalls[0]?.message)).toMatch(
      /does not directly send mail/,
    );
    expect(mutate).toHaveBeenCalledWith("p-1", expect.anything());
  });

  it("cancel is the destructive half, and a declined confirm stops it", async () => {
    const mutate = jest.fn();
    queryHooks.__setHookResultForTests(
      "useExtendDoubleOptin",
      mutationResult(jest.fn()),
    );
    queryHooks.__setHookResultForTests(
      "useCancelDoubleOptin",
      mutationResult(mutate),
    );
    mockConfirmAnswer = false;
    const result = await renderInApp(
      <DoubleOptinQueueCard
        rows={[PENDING_ROW]}
        truncated={false}
        now={Date.parse("2026-08-29T12:00:00Z")}
      />,
    );
    await fireEvent.press(
      result.getByLabelText("Cancel the pending opt-in for stuck@example.com"),
    );
    await Promise.resolve();
    expect(mockConfirmCalls).toHaveLength(1);
    expect(mockConfirmCalls[0]?.destructive).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("discloses a truncated page instead of posing as the whole queue", async () => {
    queryHooks.__setHookResultForTests(
      "useExtendDoubleOptin",
      mutationResult(jest.fn()),
    );
    queryHooks.__setHookResultForTests(
      "useCancelDoubleOptin",
      mutationResult(jest.fn()),
    );
    const result = await renderInApp(
      <DoubleOptinQueueCard rows={[PENDING_ROW]} truncated now={Date.now()} />,
    );
    expect(
      result.getByText(/More pending rows exist than this page shows/),
    ).toBeTruthy();
  });
});

describe("regions matrix", () => {
  function mountRegions(createMutate = jest.fn(), removeMutate = jest.fn()) {
    queryHooks.__setHookResultForTests(
      "useCreatePrivacyRegion",
      mutationResult(createMutate),
    );
    queryHooks.__setHookResultForTests(
      "useDeletePrivacyRegion",
      mutationResult(removeMutate),
    );
    return renderInApp(<RegionsMatrixCard regions={[REGION_ROW]} />);
  }

  it("refuses an empty region code locally — nothing leaves the phone", async () => {
    const mutate = jest.fn();
    const result = await mountRegions(mutate);
    await fireEvent.press(result.getByLabelText("Add region to the matrix"));
    expect(mutate).not.toHaveBeenCalled();
    expect(result.getByText("A region code is required.")).toBeTruthy();
  });

  it("adds a region with the chosen framework", async () => {
    const mutate = jest.fn();
    const result = await mountRegions(mutate);
    await fireEvent.changeText(result.getByLabelText("Region code"), "br");
    await fireEvent.press(result.getByLabelText("Framework LGPD"));
    await fireEvent.press(result.getByLabelText("Add region to the matrix"));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ regionCode: "br", framework: "lgpd" }),
      expect.anything(),
    );
  });

  it("removes through a destructive confirm that names the consequence", async () => {
    const mutate = jest.fn();
    const result = await mountRegions(jest.fn(), mutate);
    await fireEvent.press(result.getByLabelText("Remove region EU"));
    await Promise.resolve();
    expect(mockConfirmCalls).toHaveLength(1);
    expect(mockConfirmCalls[0]?.destructive).toBe(true);
    expect(String(mockConfirmCalls[0]?.message)).toMatch(
      /GDPR obligations will no longer be applied/,
    );
    expect(mutate).toHaveBeenCalledWith("r-1", expect.anything());
  });
});

describe("compliance screen wiring", () => {
  it("renders the portal and evidence sections for an admin", async () => {
    queryHooks.__setHookResultForTests(
      "useCompliancePrograms",
      queryResult({ data: [] }),
    );
    queryHooks.__setHookResultForTests(
      "useComplianceEvents",
      queryResult({ data: [] }),
    );
    queryHooks.__setHookResultForTests(
      "usePrivacyPortalOverview",
      queryResult({ data: { regions: [REGION_ROW], consentProof: [] } }),
    );
    queryHooks.__setHookResultForTests(
      "useDoubleOptinPending",
      queryResult({ data: { rows: [], nextCursor: "" } }),
    );
    queryHooks.__setHookResultForTests(
      "useRetentionActivity",
      queryResult({ data: { events: [], totalPurgedLast30d: 0 } }),
    );
    queryHooks.__setHookResultForTests(
      "useAgentEventWindow",
      queryResult({ data: 12 }),
    );
    const result = await renderInApp(<CompliancePostureScreen />);
    expect(result.getByText("Privacy regions")).toBeTruthy();
    expect(result.getByText("Pending double opt-ins")).toBeTruthy();
    expect(result.getByText("Retention activity")).toBeTruthy();
    expect(result.getByText("AI transparency")).toBeTruthy();
    // The live agent-event line renders from the loaded count.
    expect(
      result.getByText("12 agent-actor events logged in the last 30 days."),
    ).toBeTruthy();
    // And the consent-proof card renders its honest empty sentence.
    expect(result.getByText("No consent proof recorded")).toBeTruthy();
  });

  it("withholds every portal section below admin", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "editor" } });
    queryHooks.__setHookResultForTests(
      "useCompliancePrograms",
      queryResult({ data: [] }),
    );
    const result = await renderInApp(<CompliancePostureScreen />);
    expect(result.queryByText("Privacy regions")).toBeNull();
    expect(result.queryByText("Retention activity")).toBeNull();
    expect(result.queryByText("AI transparency")).toBeNull();
  });
});
