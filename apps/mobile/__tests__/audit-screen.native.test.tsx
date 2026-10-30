/**
 * Audit log — the route's own render contract.
 *
 * The all-route sweep mounts this screen with the scope answer still in
 * flight, so the branch it exercises is the one where `canRead` is null and
 * every gated read is switched off. The three sibling suites
 * (`audit-alerts`, `audit-nlq`, `audit-saved-views`) drive components, not the
 * route. Nothing had ever rendered `app/(tabs)/audit.tsx` with an INVESTIGATION
 * QUEUE attached.
 *
 * What that hid:
 *
 *   `investigations.data ? investigations.data.filter(...) : null` is a TRUTHY
 *   guard, not an array one. A restored persisted query cache written by a
 *   build with a different response shape (`{investigations: [...]}` is what
 *   the endpoint actually sends, and `normalizeInvestigationList` is the only
 *   thing that turns it into a list) hands the screen an object, and the
 *   header's pending-count badge takes the whole compliance surface down with
 *   "data.filter is not a function" — during the incident it exists for.
 *
 * The same file also pins the sentence this screen must never print: a failed
 * page load is not "no matching events".
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const queryHooks = require("./mocks/queryHooks.cjs");

/** Exactly what `useAuditInvestigations` resolves to: `AuditInvestigation[]`. */
const mockInvestigations: { current: Record<string, unknown> } = {
  current: {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: jest.fn(async () => undefined),
  },
};

jest.mock("@/hooks/useAuditInvestigations", () => ({
  ...(jest.requireActual("@/hooks/useAuditInvestigations") as object),
  useAuditInvestigations: () => mockInvestigations.current,
}));

// eslint-disable-next-line import/first -- must follow the hook mock.
import Audit from "../app/(tabs)/audit";

function investigationsQuery(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: jest.fn(async () => undefined),
  };
}

async function renderAudit() {
  return render(<Audit />, {
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

afterEach(() => {
  mockInvestigations.current = investigationsQuery(undefined);
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("audit — the investigation queue's pending badge", () => {
  it("counts the decidable rows it was given", async () => {
    queryHooks.__setHookResultForTests("hasAuditReadScope", true);
    mockInvestigations.current = investigationsQuery([
      // `draft` is the only decidable status (lib/auditInvestigations).
      { id: "i-1", status: "draft" },
      { id: "i-2", status: "approved" },
    ]);
    await renderAudit();
    expect(
      screen.getByLabelText("AI investigations, 1 awaiting review"),
    ).toBeTruthy();
  });

  it("survives a truthy non-array investigations payload", async () => {
    // REGRESSION. The truthy guard let `{investigations: []}` — the RAW wire
    // envelope, which only `normalizeInvestigationList` unwraps — reach
    // `.filter`, and the screen threw before it drew a single row.
    queryHooks.__setHookResultForTests("hasAuditReadScope", true);
    mockInvestigations.current = investigationsQuery({ investigations: [] });
    await expect(renderAudit()).resolves.toBeTruthy();
    // Unknown, not zero: a shape we cannot read must not claim an empty queue.
    expect(screen.getByLabelText("AI investigations")).toBeTruthy();
  });
});

describe("audit — a failed page is not an empty log", () => {
  it("never renders the empty copy for an errored list", async () => {
    queryHooks.__setHookResultForTests("hasAuditReadScope", true);
    queryHooks.__setHookResultForTests("useAuditLog", {
      data: undefined,
      error: new Error("HTTP 500"),
      isError: true,
      isFetching: false,
      isFetchingNextPage: false,
      isLoading: false,
      hasNextPage: false,
      fetchNextPage: jest.fn(async () => undefined),
      refetch: jest.fn(async () => undefined),
    });
    await renderAudit();
    expect(screen.queryByText("No audit events")).toBeNull();
    expect(screen.getAllByLabelText("Retry").length).toBeGreaterThan(0);
  });
});
