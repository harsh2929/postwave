/**
 * Side-by-side compare (desktop parity: TemplateComparePanel; server:
 * GET /campaign-templates/compare?template=a&template=b, 2..4 identifiers).
 *
 * Two layers. The BAR and the SHEET are rendered directly for their states.
 * The SHORTLIST is driven through the real library screen, because its
 * whole contract is a sequence — long-press builds, Compare reads — and the
 * thing worth pinning is that the read is armed ONLY when Compare is pressed,
 * never by the selection itself. `useTemplateCompare` is therefore mocked to
 * RECORD what it was asked for; that recorded argument is the seam under test.
 *
 * The catalogue hooks are mocked per shape for the reason
 * templates.native.test.tsx gives; the rest of the screen (actions, confirm,
 * toast, rows) is real.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import * as GateHooks from "@/hooks/useOnlineQueryGate";
import {
  parseTemplateCatalogPage,
  type TemplateCatalogPage,
} from "@/lib/templateCatalog";
import { parseTemplateCompare } from "@/lib/templateDiscovery";

jest.mock("@/hooks/useCampaignTemplates", () => {
  const state: Record<string, unknown> = {};
  return {
    __state: state,
    useTemplateCatalog: () => state["catalog"],
    useTemplateGoals: () => state["goals"],
    useTemplateDetail: () => state["detail"],
    useCloneTemplate: () => state["mutation"],
    useStartCampaignFromTemplate: () => state["mutation"],
    useSetTemplateFavorite: () => state["mutation"],
  };
});

jest.mock("@/hooks/useTemplateDiscovery", () => {
  const state: Record<string, unknown> = {};
  const empty = () => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(async () => undefined),
    refetch: jest.fn(async () => ({ data: undefined })),
  });
  const mutation = () => ({
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => undefined),
    reset: jest.fn(),
  });
  return {
    __state: state,
    useTemplateStats: empty,
    useRecentTemplateViews: empty,
    useTemplateSavedSearches: empty,
    useTemplateCollections: empty,
    useTemplateCollection: empty,
    useSavedSearchResults: empty,
    useCreateTemplateSavedSearch: mutation,
    useDeleteTemplateSavedSearch: mutation,
    useRecordTemplateView: mutation,
    useClearRecentTemplateViews: mutation,
    // RECORDED: the argument is the whole contract (see the file header).
    useTemplateCompare: (ids: readonly string[]) => {
      state["compareIds"] = [...ids];
      return empty();
    },
  };
});

import * as CatalogHooks from "@/hooks/useCampaignTemplates";
import * as DiscoveryHooks from "@/hooks/useTemplateDiscovery";

import Templates from "../app/(tabs)/templates";
import { TemplateCompareBar } from "../src/components/templates/TemplateCompareBar";
import { TemplateCompareSheet } from "../src/components/templates/TemplateCompareSheet";

const catalogState = (
  CatalogHooks as unknown as { __state: Record<string, unknown> }
).__state;
const discoveryState = (
  DiscoveryHooks as unknown as { __state: Record<string, unknown> }
).__state;
const gateHarness = GateHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

function wire(id: string, name: string) {
  return {
    id,
    slug: id,
    name,
    subject: `${name} subject`,
    variables: [],
    tags: [],
    goal: "promotional",
    usage_count: 3,
    last_used_at: "2026-07-01T09:00:00Z",
    template_kind: "editable",
    review_status: "approved",
    source_license_status: "owned",
    source_provider: "postwave",
  };
}

const NAMES = ["Spring launch", "Summer sale", "Autumn digest", "Winter wrap", "Flash offer"];
const FIVE: TemplateCatalogPage = parseTemplateCatalogPage({
  items: NAMES.map((name, index) => wire(`tpl-${index + 1}`, name)),
  page: 1,
  per_page: 24,
  total: 5,
});

const COMPARE = parseTemplateCompare({
  items: [
    { requested_identifier: "tpl-1", matched_by: "id", template: wire("tpl-1", "Spring launch") },
    { requested_identifier: "tpl-2", matched_by: "id", template: wire("tpl-2", "Summer sale") },
  ],
  unavailable_identifiers: ["ghost"],
});

function loadedCatalog(page: TemplateCatalogPage) {
  return {
    data: { pages: [page], pageParams: [1] },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(async () => undefined),
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

beforeEach(() => {
  catalogState["catalog"] = loadedCatalog(FIVE);
  catalogState["goals"] = { data: [], isError: false, refetch: jest.fn(async () => ({})) };
  catalogState["detail"] = { data: null, isLoading: false, isError: false };
  catalogState["mutation"] = {
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => null),
    reset: jest.fn(),
  };
  delete discoveryState["compareIds"];
  gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
});

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
});

/** The row's accessible name is a sentence that STARTS with the design's name. */
function row(name: string) {
  return screen.getByLabelText(new RegExp(`^${name}\\.`));
}

describe("the compare shortlist on the library", () => {
  it("long-press builds the shortlist; the read is armed only when Compare is pressed", async () => {
    await render(<Templates />, { wrapper });
    expect(screen.queryByText(/Long-press another design/)).toBeNull();

    await fireEvent(row("Spring launch"), "longPress");
    expect(screen.getByText("Long-press another design to compare")).toBeTruthy();
    expect(screen.queryByLabelText(/Compare \d designs side by side/)).toBeNull();

    await fireEvent(row("Summer sale"), "longPress");
    expect(screen.getByText("2 selected")).toBeTruthy();
    // Selection is not the read: nothing has been asked for yet.
    expect(discoveryState["compareIds"]).toEqual([]);

    await fireEvent.press(
      screen.getByLabelText("Compare 2 designs side by side"),
    );
    expect(discoveryState["compareIds"]).toEqual(["tpl-1", "tpl-2"]);
    expect(screen.getByText("Compare designs")).toBeTruthy();
  });

  it("a second long-press removes a design from the shortlist", async () => {
    await render(<Templates />, { wrapper });
    await fireEvent(row("Spring launch"), "longPress");
    await fireEvent(row("Summer sale"), "longPress");
    await fireEvent(row("Spring launch"), "longPress");
    expect(screen.getByText("Long-press another design to compare")).toBeTruthy();
    expect(row("Summer sale").props.accessibilityState?.selected).toBe(true);
    expect(row("Spring launch").props.accessibilityState?.selected).toBe(false);
  });

  it("refuses a fifth design with a stated reason, before any request", async () => {
    await render(<Templates />, { wrapper });
    for (const name of NAMES) await fireEvent(row(name), "longPress");

    expect(
      screen.getByText("Compare holds at most 4 designs — remove one first."),
    ).toBeTruthy();
    expect(screen.getByText("4 selected")).toBeTruthy();
    expect(discoveryState["compareIds"]).toEqual([]);
  });

  it("Clear empties the shortlist and takes the bar with it", async () => {
    await render(<Templates />, { wrapper });
    await fireEvent(row("Spring launch"), "longPress");
    await fireEvent(row("Summer sale"), "longPress");
    await fireEvent.press(screen.getByLabelText("Clear the compare selection"));
    expect(screen.queryByText("2 selected")).toBeNull();
    expect(screen.queryByLabelText("Clear the compare selection")).toBeNull();
  });
});

describe("TemplateCompareBar", () => {
  it("renders nothing with an empty shortlist", async () => {
    await render(
      <TemplateCompareBar count={0} onCompare={jest.fn()} onClear={jest.fn()} />,
    );
    expect(screen.queryByLabelText("Clear the compare selection")).toBeNull();
  });

  it("says what is missing below the floor, and offers Compare at it", async () => {
    const onCompare = jest.fn();
    const onClear = jest.fn();
    const view = await render(
      <TemplateCompareBar count={1} onCompare={onCompare} onClear={onClear} />,
    );
    expect(screen.getByText("Long-press another design to compare")).toBeTruthy();
    expect(screen.queryByLabelText(/side by side/)).toBeNull();

    await view.rerender(
      <TemplateCompareBar count={3} onCompare={onCompare} onClear={onClear} />,
    );
    await fireEvent.press(screen.getByLabelText("Compare 3 designs side by side"));
    expect(onCompare).toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Clear the compare selection"));
    expect(onClear).toHaveBeenCalled();
  });
});

describe("TemplateCompareSheet", () => {
  function sheet(over: Partial<React.ComponentProps<typeof TemplateCompareSheet>>) {
    return (
      <TemplateCompareSheet
        visible
        onClose={jest.fn()}
        result={null}
        loading={false}
        failed={false}
        {...over}
      />
    );
  }

  it("says it is comparing, then says it failed, without inventing a verdict", async () => {
    const view = await render(sheet({ loading: true }), { wrapper });
    expect(screen.getByText("Comparing…")).toBeTruthy();
    expect(screen.queryByText(/couldn't be resolved/)).toBeNull();

    await view.rerender(sheet({ failed: true }));
    expect(screen.getByText(/Couldn't load the comparison/)).toBeTruthy();
  });

  it("stacks one card per design with the same row order, and SAYS which identifiers were unresolved", async () => {
    await render(sheet({ result: COMPARE }), { wrapper });
    expect(screen.getByText("Spring launch")).toBeTruthy();
    expect(screen.getByText("Summer sale")).toBeTruthy();
    expect(screen.getAllByText("Goal")).toHaveLength(2);
    expect(screen.getAllByText("Used")).toHaveLength(2);
    expect(
      screen.getByText(
        "One selected design couldn't be resolved and is missing from this comparison.",
      ),
    ).toBeTruthy();
  });

  it("stays quiet about unresolved identifiers when there are none", async () => {
    await render(
      sheet({ result: { items: COMPARE.items, unavailable: [] } }),
      { wrapper },
    );
    expect(screen.queryByText(/couldn't be resolved/)).toBeNull();
  });
});
