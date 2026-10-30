import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * DELIVERABILITY#21 — app/(tabs)/custom-domains.tsx (424 lines) had no screen
 * test at all. The rungs pinned here are the ones that can quietly turn into a
 * false statement about DNS:
 *
 *  - "No custom domains" must never be what OFFLINE looks like;
 *  - a FAILED DNS-health side-read must announce itself, because a row that
 *    silently renders "—" for SPF/DKIM/DMARC is indistinguishable from a domain
 *    that genuinely published nothing (the D10 lesson the screen's own header
 *    comment cites);
 *  - the write surface is admin-gated, and a viewer must not be offered a
 *    Remove/Add/Re-check that can only 403.
 */
const mockDomains: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  refetch: jest.fn(async () => undefined),
};

const mockHealth: {
  data: unknown;
  isError: boolean;
  refetch: () => Promise<unknown>;
} = { data: undefined, isError: false, refetch: jest.fn(async () => undefined) };

const mockReputation: {
  data: unknown;
  isError: boolean;
  refetch: () => Promise<unknown>;
} = { data: undefined, isError: false, refetch: jest.fn(async () => undefined) };

/**
 * SwipeableRow is stubbed to a plain wrapper: the shared gesture-handler mock
 * only exports GestureHandlerRootView, so the real component's
 * `ReanimatedSwipeable` import renders NOTHING here and every writable row
 * would silently vanish. The stub keeps the wrapper's own label so the
 * admin-vs-viewer assertions still describe the shipped structure.
 */
jest.mock("@/components/SwipeableRow", () => {
  const RN = jest.requireActual("react-native") as typeof import("react-native");
  const ReactLocal = jest.requireActual("react") as typeof import("react");
  return {
    SwipeableRow: ({
      children,
      accessibilityLabel,
    }: {
      children: React.ReactNode;
      accessibilityLabel?: string;
    }) =>
      ReactLocal.createElement(
        RN.View,
        accessibilityLabel ? { accessibilityLabel } : {},
        children,
      ),
  };
});

jest.mock("@/hooks/useDomainOps", () => ({
  useCustomDomains: () => mockDomains,
  useVerifyCustomDomain: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCreateCustomDomain: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteCustomDomain: () => ({ mutateAsync: jest.fn(), isPending: false }),
  CUSTOM_DOMAIN_PURPOSES: [{ value: "links", label: "Tracked links" }],
  normalizeDomainInput: (raw: string) => raw.trim().toLowerCase(),
}));

jest.mock("@/hooks/useDeliverability", () => ({
  useDnsHealth: () => mockHealth,
  useSenderReputation: () => mockReputation,
  useRunDnsCheck: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import CustomDomains from "../app/(tabs)/custom-domains";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

function backed(rows: unknown[]) {
  return { value: rows, fromSnapshot: false, capturedAt: null };
}

/**
 * Matches `CustomDomain` from src/lib/deliverabilityContracts.ts exactly —
 * `dnsRecords`, not the wire's `dns_records`, because the hook returns the
 * PARSED shape. A `records: []` shim crashed DomainRowCard on
 * `row.dnsRecords.length`, which is house rule 10 in one line.
 */
const DOMAIN = {
  id: "d1",
  domain: "mail.example.com",
  purpose: "links",
  verified: false,
  dnsRecords: [],
  createdAt: "2026-07-01T00:00:00Z",
  verifiedAt: null,
};

async function renderScreen() {
  return await render(React.createElement(CustomDomains), {
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

function reset(role?: string) {
  mockDomains.data = undefined;
  mockDomains.isLoading = false;
  mockDomains.isError = false;
  mockDomains.error = null;
  mockHealth.data = undefined;
  mockHealth.isError = false;
  mockReputation.data = undefined;
  mockReputation.isError = false;
  gateHarness.__resetOnlineGateForTests();
  if (role) gateHarness.__setOnlineGateForTests({ effectiveRole: role });
}

describe("custom domains — the state ladder", () => {
  it("renders the loaded domains", async () => {
    reset("admin");
    mockDomains.data = backed([DOMAIN]);
    const screen = await renderScreen();
    expect(screen.getAllByText("mail.example.com").length).toBeGreaterThan(0);
  });

  it("says OFFLINE rather than 'No custom domains' when the gate is closed", async () => {
    reset("admin");
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "admin",
      enabled: false,
      isOnline: false,
    });
    const screen = await renderScreen();
    expect(screen.queryByText("No custom domains")).toBeNull();
    expect(screen.getAllByText(/offline/i).length).toBeGreaterThan(0);
  });

  it("claims an empty workspace only on a genuine 200 with no rows", async () => {
    reset("admin");
    mockDomains.data = backed([]);
    const screen = await renderScreen();
    expect(screen.getByText("No custom domains")).toBeTruthy();
  });

  it("does not present a FAILED load as an empty domain list", async () => {
    reset("admin");
    mockDomains.isError = true;
    mockDomains.error = new Error("gateway exploded");
    const screen = await renderScreen();
    expect(screen.queryByText("No custom domains")).toBeNull();
  });
});

describe("custom domains — the DNS-health side-read is tracked separately", () => {
  it("announces a failed health read instead of implying 'not configured'", async () => {
    reset("admin");
    mockDomains.data = backed([DOMAIN]);
    mockHealth.isError = true;
    const screen = await renderScreen();
    expect(screen.getByText(/DNS health/i)).toBeTruthy();
  });

  it("says nothing extra when health loaded fine", async () => {
    reset("admin");
    mockDomains.data = backed([DOMAIN]);
    mockHealth.data = [];
    const screen = await renderScreen();
    expect(screen.queryByText(/couldn't|could not/i)).toBeNull();
  });
});

describe("custom domains — the write surface is admin-only", () => {
  it("offers add and re-check to an admin", async () => {
    reset("admin");
    mockDomains.data = backed([DOMAIN]);
    const screen = await renderScreen();
    expect(screen.getByLabelText("Add a custom domain")).toBeTruthy();
    expect(screen.getByLabelText("Re-check DNS for all domains")).toBeTruthy();
  });

  it("withholds every write from a viewer, including the swipe row", async () => {
    reset("viewer");
    mockDomains.data = backed([DOMAIN]);
    const screen = await renderScreen();
    expect(screen.queryByLabelText("Add a custom domain")).toBeNull();
    expect(screen.queryByLabelText("Re-check DNS for all domains")).toBeNull();
    // The SwipeableRow wrapper — and therefore the Remove action it publishes
    // to the VoiceOver rotor — is not rendered at all for a viewer.
    expect(screen.queryByLabelText("mail.example.com, pending")).toBeNull();
  });

  it("does not dangle an 'Add a domain' CTA in the empty state for a viewer", async () => {
    reset("viewer");
    mockDomains.data = backed([]);
    const screen = await renderScreen();
    expect(screen.getByText("No custom domains")).toBeTruthy();
    expect(screen.queryByText("Add a domain")).toBeNull();
  });
});

describe("custom domains — the verification filter", () => {
  it("narrows to pending without claiming the workspace is empty", async () => {
    reset("admin");
    mockDomains.data = backed([
      DOMAIN,
      { ...DOMAIN, id: "d2", domain: "ok.example.com", verified: true },
    ]);
    const screen = await renderScreen();
    await fireEvent.press(screen.getByText("Verified"));
    expect(screen.getAllByText("ok.example.com").length).toBeGreaterThan(0);
    expect(screen.queryByText("mail.example.com")).toBeNull();
  });

  it("names the FILTER in its empty state, not the workspace", async () => {
    reset("admin");
    mockDomains.data = backed([
      { ...DOMAIN, id: "d2", domain: "ok.example.com", verified: true },
    ]);
    const screen = await renderScreen();
    await fireEvent.press(screen.getByText("Pending"));
    expect(screen.getByText("Nothing pending")).toBeTruthy();
    expect(screen.queryByText("No custom domains")).toBeNull();
  });
});
