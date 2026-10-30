import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockCopy = jest.fn(async (_value: string) => true);

jest.mock("@/lib/clipboard", () => ({
  copyToClipboard: (value: string) => mockCopy(value),
}));
jest.mock("@/hooks/useMcpCatalog", () => require("./mocks/queryHooks.cjs"));

// eslint-disable-next-line import/first
import { McpToolCatalogueSection } from "../src/components/mcp/McpToolCatalogueSection";
// eslint-disable-next-line import/first
import { ToastProvider } from "../src/components/Toast";
// eslint-disable-next-line import/first
import { MCP_CATALOG_PAGE_SIZE, normalizeMcpCatalog } from "../src/lib/mcpCatalog";

const queryHooks = require("./mocks/queryHooks.cjs");

/**
 * P3 — browse the MCP tool catalogue. What a render test must pin:
 *
 *   LAZY    — the 289-row document is not requested until the section is
 *             opened; the hook is called with wanted=false while folded.
 *   HONEST  — the list is labelled a server-bundled CANDIDATE in the
 *             handler's words; no row is presented as "available".
 *   NARROW  — search and category intersect, and the sentence under the
 *             field says how many of how many match.
 *   COPY    — the only action copies the exact identifier and says so.
 */

function catalogWire() {
  return [
    { name: "subscribers_list", category: "subscribers", description: "List subscribers." },
    { name: "campaign_send", category: "campaigns", description: "Send a campaign now." },
    { name: "campaign_create", category: "campaigns", description: "Create a draft campaign." },
    { name: "migrate_start", category: "migration", description: "Begin OAuth authorization." },
  ];
}

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

function loadCatalog(wire: unknown[] | null, over: Record<string, unknown> = {}) {
  queryHooks.__setHookResultForTests(
    "useMcpCatalog",
    queryResult({
      data: wire ? (normalizeMcpCatalog(wire).entries ?? undefined) : undefined,
      ...over,
    }),
  );
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

async function renderSection(gate = { enabled: true }) {
  return render(<McpToolCatalogueSection allowed gate={gate} />, { wrapper });
}

async function open(result: Awaited<ReturnType<typeof renderSection>>) {
  await fireEvent.press(result.getByLabelText("Browse the tool catalogue"));
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  mockCopy.mockClear();
});

describe("lazy and honest", () => {
  it("is folded by default and does not want the catalogue until opened", async () => {
    loadCatalog(catalogWire());
    const result = await renderSection();
    expect(result.getByText("Tool catalogue")).toBeTruthy();
    expect(result.queryByLabelText("Search the tool catalogue")).toBeNull();
    expect(queryHooks.__getHookCallsForTests("useMcpCatalog").at(-1)).toEqual([true, false]);
    await open(result);
    expect(result.getByLabelText("Search the tool catalogue")).toBeTruthy();
    expect(queryHooks.__getHookCallsForTests("useMcpCatalog").at(-1)).toEqual([true, true]);
    await fireEvent.press(result.getByLabelText("Hide the tool catalogue"));
    expect(result.queryByLabelText("Search the tool catalogue")).toBeNull();
  });

  it("labels the rows as build evidence, never as available", async () => {
    loadCatalog(catalogWire());
    const result = await renderSection();
    await open(result);
    expect(result.getByText(/Presence here is build evidence/)).toBeTruthy();
    expect(result.getByText(/Installed-client parity is not qualified/)).toBeTruthy();
    expect(result.getByText("4 tools across 3 categories.")).toBeTruthy();
    expect(result.queryByText(/\bavailable\b/i)).toBeNull();
  });

  it("states an empty catalogue in the desktop's words", async () => {
    loadCatalog([]);
    const result = await renderSection();
    await open(result);
    expect(result.getByText("Validated candidate catalogue is empty")).toBeTruthy();
  });

  it("says offline rather than empty", async () => {
    loadCatalog(null);
    const result = await renderSection({ enabled: false });
    await open(result);
    expect(result.getByText(/The tool catalogue needs a connection/)).toBeTruthy();
    expect(result.queryByText("Validated candidate catalogue is empty")).toBeNull();
  });
});

describe("search and category", () => {
  it("narrows by a case-insensitive substring and says how many match", async () => {
    loadCatalog(catalogWire());
    const result = await renderSection();
    await open(result);
    await fireEvent.changeText(result.getByLabelText("Search the tool catalogue"), "SEND");
    expect(result.getByText("1 of 4 tools match the active filters.")).toBeTruthy();
    expect(result.getByText("campaign_send")).toBeTruthy();
    expect(result.queryByText("campaign_create")).toBeNull();
    expect(result.queryByText("subscribers_list")).toBeNull();
  });

  it("intersects a category chip with the search", async () => {
    loadCatalog(catalogWire());
    const result = await renderSection();
    await open(result);
    await fireEvent.press(result.getByLabelText("campaigns, 2 tools"));
    expect(result.getByText("2 of 4 tools match the active filters.")).toBeTruthy();
    expect(result.queryByText("migrate_start")).toBeNull();
    await fireEvent.changeText(result.getByLabelText("Search the tool catalogue"), "create");
    expect(result.getByText("1 of 4 tools match the active filters.")).toBeTruthy();
    expect(result.getByText("campaign_create")).toBeTruthy();
    expect(result.queryByText("campaign_send")).toBeNull();
    await fireEvent.press(result.getByLabelText("All categories"));
    expect(result.getByText("1 of 4 tools match the active filters.")).toBeTruthy();
  });

  it("offers Clear filters when nothing matches, and it restores the list", async () => {
    loadCatalog(catalogWire());
    const result = await renderSection();
    await open(result);
    await fireEvent.changeText(result.getByLabelText("Search the tool catalogue"), "zzz");
    expect(result.getByText("No tools match these filters")).toBeTruthy();
    expect(result.getByText("0 of 4 tools match the active filters.")).toBeTruthy();
    await fireEvent.press(result.getByLabelText("Clear catalogue filters"));
    expect(result.getByText("4 tools across 3 categories.")).toBeTruthy();
    expect(result.getByText("migrate_start")).toBeTruthy();
  });

  it("pages the matches and reveals more on request", async () => {
    const many = Array.from({ length: MCP_CATALOG_PAGE_SIZE + 5 }, (_, i) => ({
      name: `tool_${String(i).padStart(3, "0")}`,
      category: "bulk",
      description: "A tool.",
    }));
    loadCatalog(many);
    const result = await renderSection();
    await open(result);
    expect(result.getByText("tool_000")).toBeTruthy();
    expect(result.queryByText(`tool_${String(MCP_CATALOG_PAGE_SIZE).padStart(3, "0")}`)).toBeNull();
    await fireEvent.press(result.getByLabelText(/Show more tools, 5 more tools available/));
    expect(result.getByText(`tool_${String(MCP_CATALOG_PAGE_SIZE + 4).padStart(3, "0")}`)).toBeTruthy();
    expect(result.queryByLabelText(/Show more tools/)).toBeNull();
  });
});

describe("copy", () => {
  it("copies the exact identifier and reports it", async () => {
    loadCatalog(catalogWire());
    const result = await renderSection();
    await open(result);
    await act(async () => {
      await fireEvent.press(result.getByLabelText("Copy tool identifier migrate_start"));
      await Promise.resolve();
    });
    expect(mockCopy).toHaveBeenCalledWith("migrate_start");
    expect(await result.findByText("Tool identifier copied")).toBeTruthy();
  });

  it("reports a clipboard that refused rather than saying Copied", async () => {
    mockCopy.mockImplementationOnce(async () => false);
    loadCatalog(catalogWire());
    const result = await renderSection();
    await open(result);
    await act(async () => {
      await fireEvent.press(result.getByLabelText("Copy tool identifier migrate_start"));
      await Promise.resolve();
    });
    expect(await result.findByText("The tool identifier could not be copied.")).toBeTruthy();
    expect(result.queryByText("Tool identifier copied")).toBeNull();
  });
});
