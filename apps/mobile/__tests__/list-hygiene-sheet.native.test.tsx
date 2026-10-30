/**
 * Sunset policies sheet — the render contract for the list-hygiene surface.
 *
 * The transport seam is pinned in src/api/listsHygiene.test.ts; this file
 * pins what an ADMIN actually sees, and the two deliberate absences:
 *
 *  - the whole surface is withheld below admin (one caption, no controls);
 *  - there is NO run affordance anywhere — the desktop anchor holds
 *    execution in draft mode and mobile matches, so the draft-mode note
 *    renders and the save button itself says the policy stays paused.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

type Query = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
};

function mockQuery(data: unknown, over: Partial<Query> = {}): Query {
  return {
    data,
    error: null,
    isLoading: false,
    isError: false,
    refetch: jest.fn(async () => undefined),
    ...over,
  };
}

const POLICY = {
  id: "p1",
  name: "Sunset 180d",
  inactiveDays: 180,
  action: "suppress",
  enabled: false,
  excludedTags: ["vip"],
  updatedAt: "2026-08-01T00:00:00Z",
};

let mockPoliciesResult: Query = mockQuery([POLICY]);
let mockExecutionsResult: Query = mockQuery([]);
const mockExecutionsCalls: (string | null)[] = [];
const mockSaveMutation = {
  isPending: false,
  mutate: jest.fn(),
};

jest.mock("@/hooks/useListHygiene", () => ({
  useSunsetPolicies: () => mockPoliciesResult,
  useSunsetExecutions: (id: string | null) => {
    mockExecutionsCalls.push(id);
    return id ? mockExecutionsResult : mockQuery(undefined, { isLoading: true });
  },
  useSaveSunsetPolicy: () => mockSaveMutation,
}));

// eslint-disable-next-line import/first -- must follow the hook mock.
import { SunsetPoliciesSheet } from "@/components/lists/SunsetPoliciesSheet";

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  mockPoliciesResult = mockQuery([POLICY]);
  mockExecutionsResult = mockQuery([]);
  mockExecutionsCalls.length = 0;
  mockSaveMutation.mutate.mockReset();
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

const noop = () => undefined;

describe("SunsetPoliciesSheet", () => {
  it("withholds the whole surface below admin with the rule, not a 403", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    await render(<SunsetPoliciesSheet visible onClose={noop} />, { wrapper });
    expect(
      screen.getByText(/Managing them needs the admin role/),
    ).toBeTruthy();
    expect(screen.queryByText("New policy")).toBeNull();
    expect(screen.queryByText("Sunset 180d")).toBeNull();
  });

  it("shows an admin the rows, the paused state, and the draft-mode note", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await render(<SunsetPoliciesSheet visible onClose={noop} />, { wrapper });
    expect(screen.getByText("Sunset 180d")).toBeTruthy();
    expect(
      screen.getByText("Inactive ≥ 180 days → Suppress · excludes vip"),
    ).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(
      screen.getByText(/no subscriber is changed from this screen/),
    ).toBeTruthy();
    // The deliberately-withheld verb: no run control anywhere.
    expect(screen.queryByText(/Run now/i)).toBeNull();
  });

  it("loads execution history only when asked, per policy", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockExecutionsResult = mockQuery([
      {
        id: "e1",
        subscriberId: "s9",
        actionTaken: "suppress",
        reason: "inactive 201d",
        executedAt: "2026-08-25T00:00:00Z",
      },
    ]);
    await render(<SunsetPoliciesSheet visible onClose={noop} />, { wrapper });
    expect(mockExecutionsCalls).not.toContain("p1");
    await fireEvent.press(screen.getByLabelText("Run history for Sunset 180d"));
    expect(mockExecutionsCalls).toContain("p1");
    expect(screen.getByText("suppress · inactive 201d")).toBeTruthy();
  });

  it("says a failed policies read FAILED instead of rendering an empty surface", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockPoliciesResult = mockQuery(undefined, {
      isError: true,
      error: Object.assign(new Error("forbidden"), { status: 500 }),
    });
    await render(<SunsetPoliciesSheet visible onClose={noop} />, { wrapper });
    expect(screen.queryByText("No sunset policies yet.")).toBeNull();
    expect(screen.getAllByText(/try again/i).length).toBeGreaterThan(0);
  });

  it("submits a create draft whose save button admits it stays paused", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await render(<SunsetPoliciesSheet visible onClose={noop} />, { wrapper });
    await fireEvent.press(screen.getByText("New policy"));
    await fireEvent.changeText(screen.getByLabelText("Policy name"), "Sunset 90");
    await fireEvent.changeText(screen.getByLabelText("Inactive days"), "90");
    await fireEvent.changeText(screen.getByLabelText("Excluded tags"), "vip, vip");
    await fireEvent.press(screen.getByText("Save (stays paused)"));
    expect(mockSaveMutation.mutate).toHaveBeenCalledTimes(1);
    expect(mockSaveMutation.mutate.mock.calls[0]?.[0]).toEqual({
      id: null,
      draft: {
        name: "Sunset 90",
        inactiveDays: 90,
        action: "suppress",
        excludedTags: ["vip"],
      },
    });
  });

  it("refuses to submit a draft the server would 400", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await render(<SunsetPoliciesSheet visible onClose={noop} />, { wrapper });
    await fireEvent.press(screen.getByText("New policy"));
    await fireEvent.changeText(screen.getByLabelText("Policy name"), "Too eager");
    await fireEvent.changeText(screen.getByLabelText("Inactive days"), "7");
    expect(
      screen.getByText(/Inactive days must be between 30 and 730/),
    ).toBeTruthy();
    await fireEvent.press(screen.getByText("Save (stays paused)"));
    expect(mockSaveMutation.mutate).not.toHaveBeenCalled();
  });
});
