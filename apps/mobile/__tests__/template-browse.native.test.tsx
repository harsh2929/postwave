/**
 * The curated feeds — a collection's designs, or a saved search's results —
 * hosted in TemplateBrowseSheet (desktop parity: TemplateDiscoveryHub's
 * Collections / Saved searches panels).
 *
 * The thing worth pinning is WHICH read each feed arms: applying a saved
 * search from a phone must run the server's FULL stored definition
 * (`GET /saved/{id}/results`), never a local re-filter that silently drops
 * the axes this phone has no control for. Both hooks are mocked to RECORD the
 * id they were given, so the assertion is about the request, not the label.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type React from "react";

import { parseTemplate, type MobileTemplate } from "@/lib/templateCatalog";

jest.mock("@/hooks/useTemplateDiscovery", () => {
  const state: Record<string, unknown> = {};
  return {
    __state: state,
    useTemplateCollection: (id: string | null) => {
      state["collectionId"] = id;
      return state["collection"];
    },
    useSavedSearchResults: (id: string | null) => {
      state["resultsId"] = id;
      return state["results"];
    },
  };
});

import * as DiscoveryHooks from "@/hooks/useTemplateDiscovery";

import { TemplateBrowseSheet } from "../src/components/templates/TemplateBrowseSheet";

const hookState = (
  DiscoveryHooks as unknown as { __state: Record<string, unknown> }
).__state;

function template(id: string, name: string): MobileTemplate {
  return parseTemplate(
    {
      id,
      slug: id,
      name,
      subject: `${name} subject`,
      variables: [],
      tags: [],
      template_kind: "editable",
      review_status: "approved",
      source_license_status: "owned",
    },
    "catalog",
  )!;
}

const SPRING = template("tpl-1", "Spring launch");
const SUMMER = template("tpl-2", "Summer sale");

function collectionResult(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
    ...over,
  };
}

function resultsResult(over: Record<string, unknown> = {}) {
  return {
    ...collectionResult(),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(async () => undefined),
    ...over,
  };
}

function sheet(over: Partial<React.ComponentProps<typeof TemplateBrowseSheet>> = {}) {
  return (
    <TemplateBrowseSheet
      source={null}
      onClose={jest.fn()}
      onOpenTemplate={jest.fn()}
      now={Date.parse("2026-09-01T00:00:00Z")}
      {...over}
    />
  );
}

beforeEach(() => {
  hookState["collection"] = collectionResult();
  hookState["results"] = resultsResult();
  delete hookState["collectionId"];
  delete hookState["resultsId"];
});

describe("a collection feed", () => {
  it("arms only the collection read, lists its designs, and opens one on tap", async () => {
    hookState["collection"] = collectionResult({
      data: {
        id: "c1",
        name: "Launches",
        description: "",
        itemCount: 2,
        etag: '"c1v1"',
        items: [SPRING, SUMMER],
      },
    });
    const onOpenTemplate = jest.fn();
    await render(
      sheet({
        source: { kind: "collection", id: "c1", name: "Launches" },
        onOpenTemplate,
      }),
    );

    expect(hookState["collectionId"]).toBe("c1");
    expect(hookState["resultsId"]).toBeNull();
    expect(screen.getByText("Launches")).toBeTruthy();
    // A collection is a membership list, not a definition — no such caption.
    expect(screen.queryByText(/full saved definition/)).toBeNull();

    await fireEvent.press(screen.getByLabelText(/^Summer sale\./));
    expect(onOpenTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tpl-2" }),
    );
  });

  it("says an empty collection is empty, and a failed read failed", async () => {
    hookState["collection"] = collectionResult({
      data: { id: "c1", name: "Launches", description: "", itemCount: 0, etag: "", items: [] },
    });
    const view = await render(
      sheet({ source: { kind: "collection", id: "c1", name: "Launches" } }),
    );
    expect(screen.getByText("This collection is empty.")).toBeTruthy();

    hookState["collection"] = collectionResult({ isError: true, error: new Error("boom") });
    await view.rerender(
      sheet({ source: { kind: "collection", id: "c1", name: "Launches" } }),
    );
    expect(screen.getByText(/Couldn't load these designs/)).toBeTruthy();
    expect(screen.queryByText("This collection is empty.")).toBeNull();
  });
});

describe("a saved-search feed", () => {
  it("arms only the results read, and says the server runs the full definition", async () => {
    hookState["results"] = resultsResult({
      data: {
        pages: [{ items: [SPRING, SUMMER], nextCursor: null }],
        pageParams: [null],
      },
    });
    await render(
      sheet({ source: { kind: "saved-search", id: "s1", name: "Spring drop" } }),
    );

    expect(hookState["resultsId"]).toBe("s1");
    expect(hookState["collectionId"]).toBeNull();
    expect(screen.getByText("Spring drop")).toBeTruthy();
    expect(screen.getByText(/full saved definition runs server-side/)).toBeTruthy();
    expect(screen.getByLabelText(/^Spring launch\./)).toBeTruthy();
    expect(screen.getByLabelText(/^Summer sale\./)).toBeTruthy();
  });

  it("distinguishes 'matches nothing' from 'still loading'", async () => {
    hookState["results"] = resultsResult({ isLoading: true, isPending: true, isSuccess: false });
    const view = await render(
      sheet({ source: { kind: "saved-search", id: "s1", name: "Spring drop" } }),
    );
    expect(screen.queryByText(/matches nothing/)).toBeNull();

    hookState["results"] = resultsResult({
      data: { pages: [{ items: [], nextCursor: null }], pageParams: [null] },
    });
    await view.rerender(
      sheet({ source: { kind: "saved-search", id: "s1", name: "Spring drop" } }),
    );
    expect(
      screen.getByText("This saved search matches nothing right now."),
    ).toBeTruthy();
  });
});

describe("closed", () => {
  it("renders nothing and arms neither read", async () => {
    await render(sheet());
    expect(hookState["collectionId"]).toBeNull();
    expect(hookState["resultsId"]).toBeNull();
    expect(screen.queryByText("Done")).toBeNull();
  });
});
