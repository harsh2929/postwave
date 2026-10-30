/**
 * Tags — the render contract for the tag catalogue.
 *
 * `lib/tagCatalogue.test.ts` covers the pure half (colour resolution, sort
 * order, envelope normalisation) and `TagCatalogueStates` owns the five-state
 * ladder, but NOTHING had ever mounted `app/(tabs)/tags.tsx`. Policy tests
 * prove the rules are right; they cannot prove the screen survives being
 * opened with a payload it did not expect.
 *
 * Two claims are pinned here, and both are about a sentence or a crash:
 *
 *  1. A FAILED FETCH IS NOT AN EMPTY WORKSPACE. "No tags yet" printed because
 *     a GET 500ed tells an operator debugging a segment that the label they
 *     are hunting does not exist.
 *  2. A TRUTHY NON-ARRAY PAYLOAD MUST NOT TAKE THE SCREEN DOWN. `sortTags`
 *     SPREADS its argument and `TagGroupFilter` MAPS its own, and both are
 *     reached through `?? []` — a NULLISH guard, which passes `{}` and
 *     `{items: []}` straight through. That is the exact route by which
 *     `app/(tabs)/api-keys.tsx` shipped "Invalid attempt to spread
 *     non-iterable instance" in this repo, and the tag catalogue has a SECOND
 *     way in that api-keys does not: `loadSnapshotBacked`'s `isStored` guard
 *     checks only that the vault record has a `value` key and a numeric
 *     `capturedAt` — never that `value` is an array — so a snapshot written by
 *     a build with a different row shape is handed to the screen verbatim.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

type Query = {
  data: unknown;
  error: unknown;
  isError: boolean;
  isLoading: boolean;
  isRefetching: boolean;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
};

function query(data: unknown, over: Partial<Query> = {}): Query {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    isRefetching: false,
    dataUpdatedAt: data === undefined ? 0 : 1_700_000_000_000,
    refetch: jest.fn(async () => undefined),
    ...over,
  };
}

/** The shape `useTagCatalogue` really resolves to — rows PLUS provenance. */
function catalogue(rows: unknown) {
  return { rows, fromSnapshot: false, capturedAt: 1_700_000_000_000 };
}

const mocks = {
  tags: query(catalogue([])),
  groups: query([]),
};

jest.mock("@/hooks/useTagCatalogue", () => ({
  useTagCatalogue: () => mocks.tags,
  useTagGroups: () => mocks.groups,
}));

// eslint-disable-next-line import/first -- must follow the hook mock.
import Tags from "../app/(tabs)/tags";

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
  mocks.tags = query(catalogue([]));
  mocks.groups = query([]);
});

describe("tags — the catalogue never lies about an empty workspace", () => {
  it("renders the rows it was given", async () => {
    mocks.tags = query(
      catalogue([
        { id: "t-1", name: "vip", created_at: "2026-01-02T03:04:05Z" },
        { id: "t-2", name: "churn-risk" },
      ]),
    );
    await render(<Tags />, { wrapper });
    expect(screen.getByText("vip")).toBeTruthy();
    expect(screen.getByText("churn-risk")).toBeTruthy();
    expect(screen.queryByText("No tags yet")).toBeNull();
  });

  it("says the load FAILED rather than 'No tags yet'", async () => {
    mocks.tags = query(undefined, {
      isError: true,
      error: new Error("HTTP 500"),
    });
    await render(<Tags />, { wrapper });
    expect(screen.queryByText("No tags yet")).toBeNull();
    expect(screen.getAllByLabelText("Retry").length).toBeGreaterThan(0);
  });
});

describe("tags — a truthy non-array payload", () => {
  it("survives a catalogue whose rows are not an array", async () => {
    // REGRESSION. `sortTags(tags.data?.rows ?? [], sort)` spreads its argument:
    // before the Array.isArray guard this threw "Invalid attempt to spread
    // non-iterable instance" and took the whole screen with it. Reachable from
    // a vault snapshot (isStored never checks `value`) or a restored persisted
    // query cache written by an older row shape.
    mocks.tags = query(catalogue({ items: [] }));
    await expect(render(<Tags />, { wrapper })).resolves.toBeTruthy();
  });

  it("survives a tag-group list that is not an array", async () => {
    // Same route, second entry point: `groups.data ?? []` feeds both
    // `TagGroupFilter` (which reads `.length` then `.map`) and `tagGroupName`
    // (`.find`). `{}.length` is undefined, so the `=== 0` early return does NOT
    // fire and the `.map` below it throws.
    mocks.groups = query({ items: [] });
    await expect(render(<Tags />, { wrapper })).resolves.toBeTruthy();
  });
});
