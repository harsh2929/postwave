/**
 * CustomFieldGovernanceSection — the render contract (register: custom-field
 * soft-limit governance, settings).
 *
 * The bar/state/patch policy is pinned in src/lib/customFieldLimits.test.ts;
 * this file pins the card:
 *
 *  - both bars read the SERVER's used/cap pair, and the badge appears only at
 *    or past the governance thresholds;
 *  - the inputs seed from the saved caps, Save is dead until one changes, and
 *    a save sends ONLY the changed cap and caches the answer;
 *  - an unparseable cap is refused before any request leaves the phone;
 *  - a 400 from the handler is shown in its own words;
 *  - below admin the bars are readable and no control is offered;
 *  - a hidden surface (403) renders nothing at all; loading/offline/garbage in
 *    the cache are silence, not a throw;
 *  - the card is MOUNTED on the Settings screen.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";
import * as AuthStore from "@/store/auth";

const mockPutCalls: unknown[] = [];
let mockPutAnswer: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};
jest.mock("@/api/customFieldLimits", () => ({
  getCustomFieldLimits: jest.fn(async () => ({ data: null, error: null })),
  putCustomFieldLimits: async (body: unknown) => {
    mockPutCalls.push(body);
    return mockPutAnswer;
  },
}));

const mockToasts: { kind: string; message: string }[] = [];
jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: (entry: { kind: string; message: string }) => {
      mockToasts.push(entry);
    },
    dismiss: () => undefined,
  }),
}));

// eslint-disable-next-line import/first -- must follow the api/toast mocks.
import { CustomFieldGovernanceSection } from "@/components/settings/CustomFieldGovernanceSection";
// eslint-disable-next-line import/first
import Settings from "../app/(tabs)/settings";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  __getQueryClientForTests: () => { setQueryData: jest.Mock };
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

const refetch = jest.fn(async () => ({}));

function result(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isFetching: false,
    isSuccess: true,
    refetch,
    ...over,
  };
}

/** The limits exactly as lib/customFieldLimits normalizes them. */
const LIMITS = {
  maxCustomFields: 1000,
  maxSearchableFields: 3,
  usedCustomFields: 12,
  usedSearchableFields: 2,
};

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

const SAVE = "Save custom-field caps";

afterEach(() => {
  mockPutCalls.length = 0;
  mockToasts.length = 0;
  mockPutAnswer = { data: null, error: null };
  refetch.mockClear();
  queryHarness.__getQueryClientForTests().setQueryData.mockClear();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
});

describe("CustomFieldGovernanceSection", () => {
  it("reads both bars off the server's numbers and seeds the inputs from them", async () => {
    queryHarness.__setQueryResultForTests(result({ data: LIMITS }));
    await render(<CustomFieldGovernanceSection />);
    expect(screen.getByText("Total fields: 12 / 1000 total fields")).toBeTruthy();
    expect(
      screen.getByText("Searchable fields: 2 / 3 searchable fields"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Existing fields are never removed by a cap — a cap only refuses the next one.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Total fields cap").props.value).toBe("1000");
    expect(screen.getByLabelText("Searchable fields cap").props.value).toBe("3");
    expect(screen.getByLabelText(SAVE).props.accessibilityState.disabled).toBe(
      true,
    );
    // Nothing to warn about at 1.2% and 67%.
    expect(screen.queryByText("At limit")).toBeNull();
    expect(screen.queryByText("Near limit")).toBeNull();
  });

  it("badges a counter that has reached its cap, and says what is refused", async () => {
    queryHarness.__setQueryResultForTests(
      result({ data: { ...LIMITS, usedSearchableFields: 3 } }),
    );
    await render(<CustomFieldGovernanceSection />);
    expect(screen.getByText("At limit")).toBeTruthy();
    expect(
      screen.getByText("A new field can still be added, but not a searchable one."),
    ).toBeTruthy();
  });

  it("sends ONLY the changed cap, caches the answer and says so", async () => {
    queryHarness.__setQueryResultForTests(result({ data: LIMITS }));
    const saved = { ...LIMITS, maxSearchableFields: 5 };
    mockPutAnswer = { data: saved, error: null };
    await render(<CustomFieldGovernanceSection />);
    await fireEvent.changeText(screen.getByLabelText("Searchable fields cap"), "5");
    expect(screen.getByLabelText(SAVE).props.accessibilityState.disabled).toBe(
      false,
    );
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPutCalls).toEqual([{ max_searchable_fields: 5 }]);
    const client = queryHarness.__getQueryClientForTests();
    expect(client.setQueryData).toHaveBeenCalledTimes(1);
    expect(client.setQueryData.mock.calls[0]?.[1]).toEqual(saved);
    expect(mockToasts).toEqual([
      { kind: "success", message: "Custom-field caps saved." },
    ]);
  });

  it("refuses an unparseable cap before any request leaves the phone", async () => {
    queryHarness.__setQueryResultForTests(result({ data: LIMITS }));
    await render(<CustomFieldGovernanceSection />);
    await fireEvent.changeText(screen.getByLabelText("Total fields cap"), "");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPutCalls).toEqual([]);
    expect(screen.getByRole("alert").props.children).toBe(
      "Total fields cap must be a whole number ≥ 0.",
    );
  });

  it("shows a rejected cap in the handler's own words", async () => {
    queryHarness.__setQueryResultForTests(result({ data: LIMITS }));
    const sentence = "max_searchable_fields must be non-negative";
    mockPutAnswer = {
      data: null,
      error: { status: 400, code: "invalid_limit", message: sentence },
    };
    await render(<CustomFieldGovernanceSection />);
    await fireEvent.changeText(screen.getByLabelText("Searchable fields cap"), "9");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPutCalls).toEqual([{ max_searchable_fields: 9 }]);
    expect(screen.getByRole("alert").props.children).toBe(sentence);
    expect(mockToasts).toEqual([{ kind: "error", message: sentence }]);
    expect(
      queryHarness.__getQueryClientForTests().setQueryData,
    ).not.toHaveBeenCalled();
  });

  it("lets a viewer read the bars but offers no control", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    queryHarness.__setQueryResultForTests(result({ data: LIMITS }));
    await render(<CustomFieldGovernanceSection />);
    expect(screen.getByText("Total fields: 12 / 1000 total fields")).toBeTruthy();
    expect(screen.queryByLabelText("Total fields cap")).toBeNull();
    expect(screen.queryByLabelText(SAVE)).toBeNull();
    expect(
      screen.getByText("Only workspace admins can change custom-field caps."),
    ).toBeTruthy();
  });

  it("renders NOTHING when the server hides the surface", async () => {
    queryHarness.__setQueryResultForTests(
      result({ isError: true, isSuccess: false, error: { status: 403 } }),
    );
    await render(<CustomFieldGovernanceSection />);
    expect(screen.queryByText("Custom fields")).toBeNull();
  });

  it("shows a skeleton on first load", async () => {
    queryHarness.__setQueryResultForTests(
      result({ isLoading: true, isPending: true, isSuccess: false }),
    );
    await render(<CustomFieldGovernanceSection />);
    expect(screen.getByLabelText("Loading custom-field limits")).toBeTruthy();
  });

  it("shows the offline notice with the gate closed and nothing cached", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(result({ data: undefined }));
    await render(<CustomFieldGovernanceSection />);
    expect(
      screen.getByText("Reconnect to load the custom-field limits."),
    ).toBeTruthy();
  });

  it("renders the empty state, not a throw, for a non-row shape in the cache", async () => {
    queryHarness.__setQueryResultForTests(result({ data: [LIMITS] }));
    await render(<CustomFieldGovernanceSection />);
    expect(screen.getByText("No custom-field limits")).toBeTruthy();
    expect(screen.queryByText(/undefined/u)).toBeNull();
  });

  it("reaches the Settings screen for an admin", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "admin", effectiveRole: "admin", tenantId: "t1" },
    });
    queryHarness.__setQueryResultForTests(
      result({ isLoading: true, isPending: true, isSuccess: false }),
    );
    await render(<Settings />, { wrapper });
    expect(screen.getByLabelText("Loading custom-field limits")).toBeTruthy();
  });
});
