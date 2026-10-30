/**
 * TrackingKeysPanel — the list half of "revoke a leaked public site key from
 * the phone" (P2.23), rendered over the REAL hook and the mocked react-query
 * harness, exactly as write-controls mounts its sibling IngestSecretsPanel.
 *
 * The states a "does it render" test never reaches, and why each is a place
 * the panel could state something false:
 *
 *   BELOW ADMIN  — the query must not run and the panel must stay absent. An
 *                  empty "Site tracking keys" section for a viewer would imply
 *                  the session inspected a register it cannot read.
 *   ERROR        — a failed GET must be its own sentence with a retry. Hiding
 *                  it renders NOTHING, which on a security surface reads as
 *                  "no keys" — the one lie this panel cannot afford.
 *   EMPTY        — once an admin's query has run, "no keys" is a fact and is
 *                  said out loud.
 *   REVOKED ROWS — stay visible with their timestamp; only the verb leaves.
 *   INVALIDATION — the revoke's settle refetches the list, so a revoked row
 *                  flips to "revoked" instead of the section vanishing.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

import { TrackingKeysPanel } from "@/components/conversions/TrackingKeysPanel";
import type { TrackingKey } from "@/lib/trackingKeys";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  __getQueryOptionsForTests: () => {
    kind: string;
    options: { queryKey: unknown[]; enabled?: boolean };
  }[];
  __getLastMutationOptionsForTests: () =>
    | { onSettled?: () => unknown }
    | undefined;
  __getQueryClientForTests: () => { invalidateQueries: jest.Mock };
};

const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetOnlineGateForTests();
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

/** The HOOK's output shape — the harness hands `data` back without a queryFn. */
const LIVE: TrackingKey = {
  id: "3f7c1a2e-9b4d-4c8e-a1f0-5d6e7f8a9b0c",
  label: "Production storefront",
  prefix: "pk_live_ab12",
  createdAt: "2026-08-30T10:00:00Z",
  revokedAt: "",
};
const RETIRED: TrackingKey = {
  id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  label: "Old storefront",
  prefix: "pk_live_zz99",
  createdAt: "2026-08-01T10:00:00Z",
  revokedAt: "2026-08-29T10:00:00Z",
};

function settled(value: unknown) {
  return {
    data: value,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: value })),
  };
}

function failed(error: unknown) {
  return {
    data: undefined,
    error,
    isError: true,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

function online(role = "admin") {
  hookHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: role,
    online: true,
  });
}

function keyQueryOptions() {
  return queryHarness
    .__getQueryOptionsForTests()
    .find((entry) => entry.options.queryKey[0] === "conversion-tracking-keys");
}

describe("role gate", () => {
  it("renders nothing below admin and never asks the server", async () => {
    online("viewer");
    await render(<TrackingKeysPanel />, { wrapper });
    expect(screen.queryByText("Site tracking keys")).toBeNull();
    expect(screen.queryByText(/No site tracking keys/u)).toBeNull();
    const query = keyQueryOptions();
    expect(query).toBeDefined();
    expect(query?.options.enabled).toBe(false);
  });

  it("asks the server for an admin", async () => {
    online("admin");
    await render(<TrackingKeysPanel />, { wrapper });
    expect(keyQueryOptions()?.options.enabled).toBe(true);
  });

  it("stays silent while the online gate is closed rather than claiming no keys", async () => {
    hookHarness.__setOnlineGateForTests({
      enabled: false,
      tenantId: "t1",
      effectiveRole: "admin",
    });
    await render(<TrackingKeysPanel />, { wrapper });
    expect(screen.queryByText("Site tracking keys")).toBeNull();
    expect(keyQueryOptions()?.options.enabled).toBe(false);
  });
});

describe("the register", () => {
  it("lists live and revoked keys and offers the verb only on the live one", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled([LIVE, RETIRED]));
    await render(<TrackingKeysPanel />, { wrapper });

    expect(screen.getByText("Site tracking keys")).toBeTruthy();
    expect(screen.getByText("Production storefront")).toBeTruthy();
    expect(screen.getByText("Old storefront")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("revoked")).toBeTruthy();
    expect(screen.getByText(/Prefix pk_live_ab12/u)).toBeTruthy();
    expect(screen.getByText(/revoked 2026-08-29T10:00:00Z/u)).toBeTruthy();

    const verbs = screen.getAllByLabelText(/^Revoke the site tracking key /u);
    expect(verbs).toHaveLength(1);
    expect(
      screen.getByLabelText("Revoke the site tracking key Production storefront"),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("Revoke the site tracking key Old storefront"),
    ).toBeNull();
  });

  it("says out loud that issuance stays on a desk and the key is public", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled([LIVE]));
    await render(<TrackingKeysPanel />, { wrapper });
    expect(screen.getByText(/anyone can read one/u)).toBeTruthy();
    expect(screen.getByText(/issued on the web or desktop admin/u)).toBeTruthy();
    // No mint affordance, by policy (lib/stoppingHalfPolicy): the panel's
    // ONLY control is the revoke. Asserted on the buttons themselves, not on
    // copy — the caption legitimately says "New keys are issued on…".
    const buttons = screen
      .getAllByRole("button")
      .map((node) => String(node.props.accessibilityLabel));
    expect(buttons).toEqual(["Revoke the site tracking key Production storefront"]);
  });

  it("calls an empty register empty, out loud", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled([]));
    await render(<TrackingKeysPanel />, { wrapper });
    expect(screen.getByText("Site tracking keys")).toBeTruthy();
    expect(
      screen.getByText("No site tracking keys are registered."),
    ).toBeTruthy();
  });

  it("names a failed read as unavailable — never as no keys — and retries", async () => {
    online();
    const result = failed({ status: 500, message: "upstream unavailable" });
    queryHarness.__setQueryResultForTests(result);
    await render(<TrackingKeysPanel />, { wrapper });

    expect(screen.getByText("Site tracking keys")).toBeTruthy();
    expect(screen.getByText("Site-key register unavailable")).toBeTruthy();
    expect(screen.queryByText(/No site tracking keys/u)).toBeNull();
    expect(screen.queryByLabelText(/^Revoke the site tracking key /u)).toBeNull();

    await fireEvent.press(screen.getByLabelText("Retry site-key register"));
    expect(result.refetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a bare object", {}],
    ["a paged envelope", { items: [], total: 0 }],
    ["undefined", undefined],
    ["null", null],
    ["a string", "x"],
    ["rows missing fields", [{ id: "k" }, { label: "no id" }]],
  ])("does not crash on %s", async (_label, payload) => {
    online();
    queryHarness.__setQueryResultForTests(settled(payload));
    expect(() => render(<TrackingKeysPanel />, { wrapper })).not.toThrow();
  });
});

describe("the revoke mutation", () => {
  it("invalidates the key list when it settles, so the row flips instead of vanishing", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled([LIVE]));
    await render(<TrackingKeysPanel />, { wrapper });

    const mutation = queryHarness.__getLastMutationOptionsForTests();
    expect(mutation?.onSettled).toBeDefined();
    mutation?.onSettled?.();
    expect(
      queryHarness.__getQueryClientForTests().invalidateQueries,
    ).toHaveBeenCalledWith({ queryKey: ["conversion-tracking-keys"] });
  });
});
