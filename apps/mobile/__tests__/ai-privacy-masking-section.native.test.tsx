/**
 * AiPrivacyMaskingSection — the render contract (register: AI PII-masking
 * per-field toggles, settings).
 *
 * The normalizer/policy is pinned in src/lib/aiPiiMasking.test.ts and the
 * transport in src/api/aiPiiMasking.test.ts; this file pins the card:
 *
 *  - built-in identifiers render locked ON with their hint; custom fields
 *    render as live switches; the summary counts, never fabricates;
 *  - a flip PATCHes exactly one field, writes the server's answer into the
 *    query cache (the PATCH answers the whole config) and mockToasts;
 *  - a 403 on save mockToasts the role rule; a 503 pii_gateway_unconfigured (or
 *    404) HIDES the card; a bare 503 is an outage and shows Retry;
 *  - below admin, and under an API key, the card is omitted entirely;
 *  - a paged envelope / bare array in the cache renders the empty state;
 *  - the card is MOUNTED on the Settings screen for an admin.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";
import * as AuthStore from "@/store/auth";

const mockPatchCalls: unknown[] = [];
let mockPatchAnswer: { data: unknown; error: unknown } = { data: null, error: null };
jest.mock("@/api/aiPiiMasking", () => ({
  getPiiMaskingConfig: jest.fn(async () => ({ data: null, error: null })),
  patchPiiMaskingConfig: async (body: unknown) => {
    mockPatchCalls.push(body);
    return mockPatchAnswer;
  },
}));

const mockToasts: Array<{ kind: string; message: string }> = [];
jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: (entry: { kind: string; message: string }) => {
      mockToasts.push(entry);
    },
    dismiss: () => undefined,
  }),
}));

// eslint-disable-next-line import/first -- must follow the api/toast mocks.
import { AiPrivacyMaskingSection } from "@/components/settings/AiPrivacyMaskingSection";
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

/** The config exactly as lib/aiPiiMasking normalizes it (the query's data). */
const CONFIG = {
  builtInFields: ["email"],
  fields: [
    { fieldName: "email", sensitive: true, builtIn: true },
    { fieldName: "company", sensitive: false, builtIn: false },
    { fieldName: "salary", sensitive: true, builtIn: false },
  ],
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

afterEach(() => {
  mockPatchCalls.length = 0;
  mockToasts.length = 0;
  mockPatchAnswer = { data: null, error: null };
  refetch.mockClear();
  queryHarness.__getQueryClientForTests().setQueryData.mockClear();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
});

describe("AiPrivacyMaskingSection", () => {
  it("renders built-ins locked on, custom fields live, and a counted summary", async () => {
    queryHarness.__setQueryResultForTests(result({ data: CONFIG }));
    await render(<AiPrivacyMaskingSection />);
    expect(screen.getByText("AI privacy")).toBeTruthy();
    expect(screen.getByText("2 of 3 masked")).toBeTruthy();
    const email = screen.getByLabelText("email");
    expect(email.props.accessibilityState).toEqual({ checked: true, disabled: true });
    expect(screen.getByText("Built-in identifier — always masked.")).toBeTruthy();
    const company = screen.getByLabelText("company");
    expect(company.props.accessibilityState).toEqual({ checked: false, disabled: false });
    expect(screen.getByLabelText("salary").props.accessibilityState.checked).toBe(true);
    expect(screen.getByText(/no client-facing audit toggle/u)).toBeTruthy();
  });

  it("flips one field with one PATCH, caches the server's answer, and mockToasts", async () => {
    queryHarness.__setQueryResultForTests(result({ data: CONFIG }));
    const next = {
      ...CONFIG,
      fields: CONFIG.fields.map((f) =>
        f.fieldName === "company" ? { ...f, sensitive: true } : f,
      ),
    };
    mockPatchAnswer = { data: next, error: null };
    await render(<AiPrivacyMaskingSection />);
    await fireEvent(screen.getByLabelText("company"), "valueChange", true);
    await act(async () => {});
    expect(mockPatchCalls).toEqual([{ fields: [{ field_name: "company", sensitive: true }] }]);
    const client = queryHarness.__getQueryClientForTests();
    expect(client.setQueryData).toHaveBeenCalledTimes(1);
    expect(client.setQueryData.mock.calls[0]?.[1]).toEqual(next);
    expect(mockToasts).toEqual([
      { kind: "success", message: '"company" is now masked from AI models.' },
    ]);
  });

  it("never PATCHes a built-in identifier", async () => {
    queryHarness.__setQueryResultForTests(result({ data: CONFIG }));
    await render(<AiPrivacyMaskingSection />);
    await fireEvent(screen.getByLabelText("email"), "valueChange", false);
    await act(async () => {});
    expect(mockPatchCalls).toEqual([]);
  });

  it("toasts the role rule when the server answers 403 on save", async () => {
    queryHarness.__setQueryResultForTests(result({ data: CONFIG }));
    mockPatchAnswer = { data: null, error: { status: 403, message: "forbidden" } };
    await render(<AiPrivacyMaskingSection />);
    await fireEvent(screen.getByLabelText("company"), "valueChange", true);
    await act(async () => {});
    expect(mockToasts).toEqual([
      {
        kind: "error",
        message: "Only workspace admins can change which fields are masked from AI models.",
      },
    ]);
    expect(queryHarness.__getQueryClientForTests().setQueryData).not.toHaveBeenCalled();
  });

  it("HIDES on 503 pii_gateway_unconfigured — a product boundary, not an outage", async () => {
    queryHarness.__setQueryResultForTests(
      result({
        isError: true,
        isSuccess: false,
        error: Object.assign(new Error("PII gateway is not configured"), {
          status: 503,
          code: "pii_gateway_unconfigured",
        }),
      }),
    );
    await render(<AiPrivacyMaskingSection />);
    expect(screen.toJSON()).toBeNull();
  });

  it("hides on a 404 too (route absent on this deployment)", async () => {
    queryHarness.__setQueryResultForTests(
      result({
        isError: true,
        isSuccess: false,
        error: Object.assign(new Error("gone"), { status: 404 }),
      }),
    );
    await render(<AiPrivacyMaskingSection />);
    expect(screen.toJSON()).toBeNull();
  });

  // One `it` per render: RNTL's `screen` stays bound to an explicitly
  // unmounted tree, so a second render inside one test queries a dead tree.
  it("treats a bare 503 as an outage and offers a Retry wired to THIS query", async () => {
    queryHarness.__setQueryResultForTests(
      result({
        isError: true,
        isSuccess: false,
        error: Object.assign(new Error("upstream down"), { status: 503 }),
      }),
    );
    await render(<AiPrivacyMaskingSection />);
    expect(screen.getByText("AI privacy")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("is omitted entirely below admin, even with a config cached", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    queryHarness.__setQueryResultForTests(result({ data: CONFIG }));
    await render(<AiPrivacyMaskingSection />);
    expect(screen.toJSON()).toBeNull();
  });

  it("is omitted under an API key (no session role to floor at admin)", async () => {
    authHarness.__setAuthStateForTests({ mode: "api_key" });
    queryHarness.__setQueryResultForTests(result({ data: CONFIG }));
    await render(<AiPrivacyMaskingSection />);
    expect(screen.toJSON()).toBeNull();
  });

  it("renders the empty state, not a throw, for a paged envelope in the cache", async () => {
    queryHarness.__setQueryResultForTests(result({ data: { items: [] } }));
    await render(<AiPrivacyMaskingSection />);
    expect(screen.getByText("No subscriber fields configured yet")).toBeTruthy();
  });

  it("renders the empty state, not a throw, for a bare array in the cache", async () => {
    queryHarness.__setQueryResultForTests(result({ data: [CONFIG.fields[0]] }));
    await render(<AiPrivacyMaskingSection />);
    expect(screen.getByText("No subscriber fields configured yet")).toBeTruthy();
  });

  it("is MOUNTED on the Settings screen for an admin", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "admin", effectiveRole: "admin", tenantId: "t1" },
    });
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await render(<Settings />, { wrapper });
    expect(screen.getByLabelText("Loading AI privacy settings")).toBeTruthy();
  });
});
