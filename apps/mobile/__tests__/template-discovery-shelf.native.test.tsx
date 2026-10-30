/**
 * The discovery shelf above the catalogue — the stats line, recently viewed,
 * saved searches and collections (desktop parity: TemplateDiscoveryHub plus
 * the stats tiles of Templates.tsx) — rendered through the REAL header with
 * the discovery hooks mocked per shape, for the reason
 * templates.native.test.tsx gives: one shared query result cannot stand in
 * for four differently-shaped reads at once.
 *
 * Every fixture is built by the real parser from a payload shaped like the
 * Go marshaller's (discovery_state.go / extras.go), so a wire-shape drift
 * shows up here rather than as an empty shelf in production.
 *
 * WHAT IS DELIBERATELY NOT MOCKED. ConfirmSheet and Toast are real: the
 * delete-behind-a-confirm on a long-press is the one destructive act on this
 * shelf, and stubbing the confirm would make the assertion about a stub.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import {
  parseRecentTemplateViews,
  parseTemplateCollections,
  parseTemplateSavedSearches,
  parseTemplateStats,
} from "@/lib/templateDiscovery";

jest.mock("@/hooks/useTemplateDiscovery", () => {
  const state: Record<string, unknown> = {};
  return {
    __state: state,
    useTemplateStats: () => state["stats"],
    useRecentTemplateViews: () => state["recents"],
    useTemplateSavedSearches: () => state["saved"],
    useTemplateCollections: () => state["collections"],
    useCreateTemplateSavedSearch: () => state["createSaved"],
    useDeleteTemplateSavedSearch: () => state["deleteSaved"],
  };
});

import * as DiscoveryHooks from "@/hooks/useTemplateDiscovery";

import {
  TemplateLibraryHeader,
  type TemplateLibraryHeaderProps,
} from "../src/components/templates/TemplateLibraryHeader";

const hookState = (
  DiscoveryHooks as unknown as { __state: Record<string, unknown> }
).__state;

const TEMPLATE_WIRE = {
  id: "tpl-1",
  slug: "spring-launch",
  name: "Spring launch",
  subject: "The spring drop is live",
  variables: [],
  tags: [],
  goal: "promotional",
  template_kind: "editable",
  review_status: "approved",
  source_license_status: "owned",
};

/** extras.go Stats — `omitempty` fields left out, as the marshaller does. */
const STATS = parseTemplateStats({
  total: 12,
  mine: 3,
  featured: 1,
  favorites: 2,
  used_last_30d: 5,
})!;
const RECENTS = parseRecentTemplateViews({
  items: [
    {
      template: TEMPLATE_WIRE,
      view_count: 2,
      first_viewed_at: "2026-08-19T10:00:00Z",
      last_viewed_at: "2026-08-20T10:00:00Z",
    },
  ],
});
const SAVED = parseTemplateSavedSearches({
  items: [
    {
      id: "s1",
      name: "Spring drop",
      filters: { q: "spring", goal: "promotional" },
      obsolete_filters: [],
      version: 1,
      etag: '"s1v1"',
    },
  ],
});
const COLLECTIONS = parseTemplateCollections({
  items: [
    {
      id: "c1",
      name: "Launches",
      description: "",
      template_ids: ["tpl-1", "tpl-2"],
      item_count: 2,
      version: 1,
      etag: '"c1v1"',
    },
  ],
});

function queryResult(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data })),
  };
}

function mutationResult() {
  return {
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => undefined),
    reset: jest.fn(),
  };
}

function headerProps(
  over: Partial<TemplateLibraryHeaderProps> = {},
): TemplateLibraryHeaderProps {
  return {
    online: true,
    shelf: "all",
    onShelfChange: jest.fn(),
    sort: "recommended",
    onSortChange: jest.fn(),
    query: "",
    goal: null,
    onOpenTemplate: jest.fn(),
    onOpenSavedSearch: jest.fn(),
    onOpenCollection: jest.fn(),
    ...over,
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
  hookState["stats"] = queryResult(undefined);
  hookState["recents"] = queryResult([]);
  hookState["saved"] = queryResult([]);
  hookState["collections"] = queryResult([]);
  hookState["createSaved"] = mutationResult();
  hookState["deleteSaved"] = mutationResult();
});

describe("the stats line", () => {
  it("renders the workspace's numbers as one sentence, never zero-filled tiles", async () => {
    hookState["stats"] = queryResult(STATS);
    await render(<TemplateLibraryHeader {...headerProps()} />, { wrapper });
    expect(
      screen.getByText("12 designs · 3 mine · 2 favourited · 5 used in 30 days"),
    ).toBeTruthy();
  });

  it("says nothing while the rollup is absent", async () => {
    await render(<TemplateLibraryHeader {...headerProps()} />, { wrapper });
    expect(screen.queryByText(/designs ·/)).toBeNull();
  });
});

describe("the rails", () => {
  it("hides every empty rail — an empty label would be furniture", async () => {
    await render(<TemplateLibraryHeader {...headerProps()} />, { wrapper });
    expect(screen.queryByText("Recently viewed")).toBeNull();
    expect(screen.queryByText("Saved searches")).toBeNull();
    expect(screen.queryByText("Collections")).toBeNull();
    // The catalog controls are always there, though.
    expect(screen.getByText("Gallery")).toBeTruthy();
    expect(screen.getByLabelText("Sort by most used")).toBeTruthy();
  });

  it("puts recently viewed designs on the shelf and opens one on tap", async () => {
    hookState["recents"] = queryResult(RECENTS);
    const onOpenTemplate = jest.fn();
    await render(<TemplateLibraryHeader {...headerProps({ onOpenTemplate })} />, {
      wrapper,
    });

    expect(screen.getByText("Recently viewed")).toBeTruthy();
    await fireEvent.press(
      screen.getByLabelText("Open Spring launch, viewed recently"),
    );
    expect(onOpenTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tpl-1", name: "Spring launch" }),
    );
  });

  it("lists collections with their sizes and opens one", async () => {
    hookState["collections"] = queryResult(COLLECTIONS);
    const onOpenCollection = jest.fn();
    await render(
      <TemplateLibraryHeader {...headerProps({ onOpenCollection })} />,
      { wrapper },
    );

    expect(screen.getByText("Launches (2)")).toBeTruthy();
    await fireEvent.press(
      screen.getByLabelText("Open the collection Launches, 2 designs"),
    );
    expect(onOpenCollection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1", name: "Launches" }),
    );
  });

  it("hands the shelf and sort choices up, not merely repaints", async () => {
    const onShelfChange = jest.fn();
    const onSortChange = jest.fn();
    await render(
      <TemplateLibraryHeader
        {...headerProps({ onShelfChange, onSortChange })}
      />,
      { wrapper },
    );

    await fireEvent.press(screen.getByText("Gallery"));
    expect(onShelfChange).toHaveBeenCalledWith("gallery");
    await fireEvent.press(screen.getByLabelText("Sort by name"));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });
});

describe("saved searches", () => {
  it("offers 'Save this search' only while something is narrowed", async () => {
    await render(<TemplateLibraryHeader {...headerProps()} />, { wrapper });
    expect(screen.queryByLabelText("Save the current search")).toBeNull();
  });

  it("stores exactly the axes the server keeps, under a name derived from the search", async () => {
    const createSaved = mutationResult();
    hookState["createSaved"] = createSaved;
    await render(
      <TemplateLibraryHeader
        {...headerProps({
          query: "spring",
          goal: "promotional",
          shelf: "favorites",
          sort: "most_used",
        })}
      />,
      { wrapper },
    );

    await fireEvent.press(screen.getByLabelText("Save the current search"));

    // `favorites` is NOT a source — it is `favorited: true` — and the
    // lifecycle axis is always named, because the server's empty default
    // means "both shelves" (campaigntemplates.go:684).
    expect(createSaved.mutate).toHaveBeenCalledWith(
      {
        name: "“spring” · Promotional · Favorites · Most used",
        filters: {
          q: "spring",
          goal: "promotional",
          favorited: true,
          archived: "active",
          sort: "most_used",
        },
      },
      expect.anything(),
    );
  });

  it("does not offer saving while offline — the POST is not queued", async () => {
    await render(
      <TemplateLibraryHeader
        {...headerProps({ online: false, query: "spring" })}
      />,
      { wrapper },
    );
    expect(screen.queryByLabelText("Save the current search")).toBeNull();
  });

  it("runs a saved search on tap, and deletes only behind a confirm on long-press", async () => {
    hookState["saved"] = queryResult(SAVED);
    const deleteSaved = mutationResult();
    hookState["deleteSaved"] = deleteSaved;
    const onOpenSavedSearch = jest.fn();
    await render(
      <TemplateLibraryHeader {...headerProps({ onOpenSavedSearch })} />,
      { wrapper },
    );

    const chip = screen.getByLabelText("Run the saved search Spring drop");
    await fireEvent.press(chip);
    expect(onOpenSavedSearch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1", name: "Spring drop" }),
    );

    await fireEvent(chip, "longPress");
    expect(screen.getByText("Delete “Spring drop”?")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Cancel"));
    expect(deleteSaved.mutate).not.toHaveBeenCalled();

    await fireEvent(chip, "longPress");
    await fireEvent.press(screen.getByLabelText("Delete"));
    // The strong tag rides along: the route demands If-Match.
    expect(deleteSaved.mutate).toHaveBeenCalledWith(
      { id: "s1", etag: '"s1v1"' },
      expect.anything(),
    );
  });
});
