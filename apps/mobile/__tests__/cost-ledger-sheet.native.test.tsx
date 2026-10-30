/**
 * Cost ledger — the render contract for the cursor-paged drilldown behind
 * the API usage & cost section.
 *
 * The wire is mocked at `rawRequest`, keyed on the `cursor` query param, so
 * the sheet's real paging (fetchCostLedgerPage → normalizeCostLedger →
 * ledgerReducer) stays in the path. What this protects:
 *   - a boundary row the server re-serves must not render twice (double
 *     cost on a ledger);
 *   - a failed page must say FAILED, keep the pages already on screen, and
 *     retry the page that failed rather than page one again;
 *   - an empty window is stated in words, not left blank;
 *   - nothing is fetched while offline.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

type WireResult = {
  data?: unknown;
  error?: { status: number; message: string };
};

/** Pages keyed by the `cursor` param ("" = page one). */
const mockPages: Record<string, WireResult> = {};
const mockRequested: string[] = [];

jest.mock("@/api/request", () => {
  const actual = jest.requireActual("@/api/request") as object;
  return {
    ...actual,
    __esModule: true,
    rawRequest: async (_method: string, path: string) => {
      mockRequested.push(String(path));
      const [base, query = ""] = String(path).split("?");
      if (base !== "/api/v1/costs/ledger") {
        return { error: { status: 404, message: "unrouted in test" } };
      }
      const cursor = new URLSearchParams(query).get("cursor") ?? "";
      return mockPages[cursor] ?? { error: { status: 500, message: "no page for cursor" } };
    },
  };
});

import * as Gate from "@/hooks/useOnlineQueryGate";

import { CostLedgerSheet } from "@/components/billing/CostLedgerSheet";

const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
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

function row(id: number, kind = "send") {
  return { id, apiKeyId: "k1", kind, cents: 2, quantity: 1, at: "2026-08-31T10:00:00Z" };
}

const ROW = /^(send|ai_generation) on /u;
const noop = () => undefined;

beforeEach(() => {
  mockRequested.length = 0;
  for (const k of Object.keys(mockPages)) delete mockPages[k];
  mockPages[""] = { data: { rows: [row(1), row(2), row(3)], nextCursor: "3" } };
  // The keyset boundary row (3) comes back again on page two.
  mockPages["3"] = { data: { rows: [row(3), row(4, "ai_generation")] } };
  hookHarness.__setOnlineGateForTests({ enabled: true, tenantId: "t1", effectiveRole: "viewer" });
});

afterEach(() => {
  hookHarness.__resetOnlineGateForTests();
});

describe("cost ledger sheet render contract", () => {
  it("loads page one on open, pages with Load more, and de-dupes the boundary row", async () => {
    await render(<CostLedgerSheet visible days={30} onClose={noop} />, { wrapper });

    expect(await screen.findAllByLabelText(ROW)).toHaveLength(3);
    expect(screen.getByText("Itemized metering entries, last 30 days. Cost figures come from the metering ledger.")).toBeTruthy();
    // Every page-one row carries the same sentence (same kind, key, quantity
    // and cents), so the match is all three of them, not one.
    expect(screen.getAllByLabelText(/^send on .+, key k1: quantity 1, \$0\.02\.$/u)).toHaveLength(3);
    expect(mockRequested).toEqual(["/api/v1/costs/ledger?since=30d&limit=50"]);

    await fireEvent.press(screen.getByLabelText("Load more ledger entries"));

    await waitFor(() => expect(screen.getAllByLabelText(ROW)).toHaveLength(4));
    expect(mockRequested[1]).toBe("/api/v1/costs/ledger?since=30d&cursor=3&limit=50");
    expect(screen.getByLabelText(/^ai_generation on /u)).toBeTruthy();
    // The final page carried no nextCursor: the list is complete.
    expect(screen.queryByLabelText("Load more ledger entries")).toBeNull();
  });

  it("says the ledger FAILED with Retry rather than 'no entries', and recovers", async () => {
    mockPages[""] = { error: { status: 500, message: "upstream unavailable" } };
    await render(<CostLedgerSheet visible days={30} onClose={noop} />, { wrapper });

    expect(await screen.findByText("Cost ledger couldn't be loaded.")).toBeTruthy();
    expect(screen.queryByText(/No ledger entries/u)).toBeNull();
    expect(screen.queryAllByLabelText(ROW)).toHaveLength(0);

    mockPages[""] = { data: { rows: [row(1)] } };
    await fireEvent.press(screen.getByLabelText("Retry loading cost ledger"));

    expect(await screen.findAllByLabelText(ROW)).toHaveLength(1);
    expect(screen.queryByText("Cost ledger couldn't be loaded.")).toBeNull();
    expect(mockRequested[1]).toBe("/api/v1/costs/ledger?since=30d&limit=50");
  });

  it("offers no Retry on a verdict a retry cannot change", async () => {
    mockPages[""] = { error: { status: 403, message: "forbidden" } };
    await render(<CostLedgerSheet visible days={30} onClose={noop} />, { wrapper });

    expect(await screen.findByText("Cost ledger couldn't be loaded.")).toBeTruthy();
    expect(screen.queryByLabelText("Retry loading cost ledger")).toBeNull();
  });

  it("keeps page one when Load more fails, and retries the failed page, not page one", async () => {
    mockPages["3"] = { error: { status: 500, message: "upstream unavailable" } };
    await render(<CostLedgerSheet visible days={30} onClose={noop} />, { wrapper });

    expect(await screen.findAllByLabelText(ROW)).toHaveLength(3);
    await fireEvent.press(screen.getByLabelText("Load more ledger entries"));

    expect(await screen.findByText("Cost ledger couldn't be loaded.")).toBeTruthy();
    expect(screen.getAllByLabelText(ROW)).toHaveLength(3);

    mockPages["3"] = { data: { rows: [row(4, "ai_generation")] } };
    await fireEvent.press(screen.getByLabelText("Retry loading cost ledger"));

    await waitFor(() => expect(screen.getAllByLabelText(ROW)).toHaveLength(4));
    expect(mockRequested[2]).toBe("/api/v1/costs/ledger?since=30d&cursor=3&limit=50");
  });

  it("states an empty window in words", async () => {
    mockPages[""] = { data: { rows: [] } };
    await render(<CostLedgerSheet visible days={7} onClose={noop} />, { wrapper });

    expect(await screen.findByText("No ledger entries in the last 7 days.")).toBeTruthy();
    expect(screen.queryByLabelText("Load more ledger entries")).toBeNull();
  });

  it("does not fetch while offline, and says so", async () => {
    hookHarness.__setOnlineGateForTests({ enabled: false, tenantId: "t1", effectiveRole: "viewer" });
    await render(<CostLedgerSheet visible days={30} onClose={noop} />, { wrapper });

    expect(await screen.findByText("The cost ledger needs a connection — reconnect to load it.")).toBeTruthy();
    expect(mockRequested).toEqual([]);
    expect(screen.queryByText(/No ledger entries/u)).toBeNull();
  });

  it("fetches nothing until it is opened", async () => {
    await render(<CostLedgerSheet visible={false} days={30} onClose={noop} />, { wrapper });
    await waitFor(() => expect(mockRequested).toEqual([]));
  });
});
