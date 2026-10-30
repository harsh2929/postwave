/**
 * The send-preview request must not queue behind the campaign GET.
 *
 * `useCampaignSendPreview` was called with `{ enabled: Boolean(c) }`, where `c`
 * is the campaign query's data — so a request that needs nothing but the ROUTE
 * ID waited for a full round trip that had already been issued. Two sequential
 * requests where two parallel ones would do, on the screen an operator opens
 * immediately before pressing Send.
 *
 * The gate bought nothing. The hook already refuses to run without an id, a
 * tenant, or connectivity (`enabled: active && gate.enabled &&
 * Boolean(gate.tenantId && id)` in useCampaignSendChecks.ts) and already
 * swallows a missing endpoint via `isOptionalEndpointError`.
 *
 * THE ASSERTION IS ON THE CALL SITE, because that is where the defect was.
 * Mocking the hook module is the seam that makes the route's argument
 * observable: the real hook's own `useQuery` options are not reachable through
 * this harness (the route's other data hooks resolve to the shared
 * queryHooks proxy, which never calls useQuery at all).
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

type PreviewCall = Record<string, unknown> | undefined;

/**
 * On globalThis, not module scope. `jest.mock` factories are hoisted into a
 * separate evaluation of this module, so a module-scoped array is pushed to by
 * the factory and read as empty by the test body — two different arrays that
 * look like one.
 */
function previewCalls(): PreviewCall[] {
  const g = globalThis as { __previewCalls?: PreviewCall[] };
  g.__previewCalls ??= [];
  return g.__previewCalls;
}

jest.mock("@/hooks/useCampaignSendChecks", () => ({
  useCampaignSendPreview: (
    _id: string | undefined,
    options?: Record<string, unknown>,
  ) => {
    // globalThis directly: a jest.mock factory is hoisted above this file's
    // own declarations and may not reference them (jest enforces it), so the
    // recording array cannot live in module scope.
    ((globalThis as { __previewCalls?: PreviewCall[] }).__previewCalls ??=
      []).push(options);
    return {
      data: undefined,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: true,
      refetch: jest.fn(),
    };
  },
  useCampaignChecklist: () => ({
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: true,
    refetch: jest.fn(),
  }),
}));

const ROUTE_ID = "22222222-2222-4222-8222-222222222222";
let mockRouteParams: Record<string, string> = { id: ROUTE_ID };

jest.mock("expo-router", () => {
  const actual = jest.requireActual<Record<string, unknown>>("expo-router");
  return { ...actual, useLocalSearchParams: () => mockRouteParams };
});

// eslint-disable-next-line import/first -- must follow the mocks above.
import * as QueryHooks from "@/hooks/useCampaigns";
// eslint-disable-next-line import/first -- must follow the mocks above.
import CampaignDetail from "../app/(tabs)/campaigns/[id]";

const hooks = QueryHooks as unknown as {
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  previewCalls().length = 0;
  mockRouteParams = { id: ROUTE_ID };
  hooks.__resetHookResultsForTests();
  hooks.__resetOnlineGateForTests();
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

describe("campaign detail issues its send-preview in parallel", () => {
  it("does not disable the preview while the campaign is still loading", async () => {
    // The campaign request is in flight: no data yet. This is the exact state
    // in which the old `enabled: Boolean(c)` evaluated to false.
    hooks.__setHookResultForTests("useCampaign", {
      data: undefined,
      error: null,
      isError: false,
      isFetching: true,
      isLoading: true,
      refetch: jest.fn(),
    });

    render(<CampaignDetail />, { wrapper });

    // Vacuity floor: if the route stopped calling the hook, an `every` over an
    // empty list would pass while proving nothing.
    // React 19 renders on a deferred tick here, so the component body has not
    // run when render() returns.
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    for (const options of previewCalls()) {
      expect(options?.enabled).not.toBe(false);
    }
  });
});
