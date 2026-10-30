/**
 * Assets — the render contract for the library grid, its filter rails, the
 * detail sheet and the upload sheet.
 *
 * WHAT THIS FILE EXISTS TO CATCH. Two classes of claim, both of which look fine
 * in code review and are catastrophic on a phone:
 *
 *   1. A CONFIDENT ZERO. The list envelope carries `counts` describing the
 *      whole tenant set, and a payload that omitted it must produce NO badges
 *      rather than five zeros — and a failed fetch must never render as "No
 *      images yet". The usage block is the sharper case: "nothing uses this"
 *      is the last sentence an operator reads before deleting an image out of
 *      a scheduled campaign, so a failed usage check must say it failed.
 *   2. AN AFFORDANCE THAT CANNOT WORK. Upload and delete are `editor` +
 *      online-only, and both are HIDDEN rather than disabled-with-an-error for
 *      a viewer or an offline session.
 *
 * WHY THE HOOKS ARE MOCKED PER HOOK. The shared `@tanstack/react-query`
 * harness sets ONE result for every `useQuery` in the module graph, which on
 * this screen would hand the folder rail the asset page and the tag rail the
 * same thing — the shape mismatch that lets a whole suite pass while asserting
 * nothing. Each hook below is given the shape it really resolves to.
 *
 * The two SHEETS are still rendered directly with props rather than opened by a
 * tap, because both live behind a `Modal` driven by route state and both take
 * their data as props — driving them directly is what lets the failed / loading
 * / empty branches of the usage block be exercised at all.
 *
 * expo-image-picker and expo-clipboard are mocked because they are native
 * modules with no JS fallback; the DECISIONS they feed (size, format, stored
 * filename) are pure and are tested in src/lib/assetUploadPolicy.test.ts.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { AssetDetailSheet } from "@/components/assets/AssetDetailSheet";
import { AssetFilterRails } from "@/components/assets/AssetFilterRails";
import { AssetTile } from "@/components/assets/AssetTile";
import { AssetUploadSheet } from "@/components/assets/AssetUploadSheet";
import { AssetUsageBlock } from "@/components/assets/AssetUsageBlock";
import {
  parseAsset,
  parseAssetDetail,
  parseAssetFolders,
  parseAssetPage,
  parseAssetTags,
  type MobileAsset,
} from "@/lib/assetLibrary";

import Assets from "../app/(tabs)/assets";

// Both `jest.mock` calls below are hoisted above the imports above them by
// babel-plugin-jest-hoist, so they take effect before `Assets` is required.
// The factories only close over `mockHooks`; they never read it at factory
// time, which is what keeps the const declaration legal down here.
jest.mock("@/lib/assetCapture", () => ({
  pickAssetFromLibrary: jest.fn(async () => ({ status: "cancelled" })),
  captureAssetWithCamera: jest.fn(async () => ({ status: "cancelled" })),
  copyToClipboard: jest.fn(async () => true),
}));

const mockHooks: {
  library: unknown;
  folders: unknown;
  tags: unknown;
  detail: unknown;
} = { library: null, folders: null, tags: null, detail: null };

jest.mock("@/hooks/useAssets", () => ({
  useAssetLibrary: () => mockHooks.library,
  useAssetFolders: () => mockHooks.folders,
  useAssetTags: () => mockHooks.tags,
  useAssetDetail: () => mockHooks.detail,
  useUploadAsset: () => ({
    isPending: false,
    mutateAsync: jest.fn(async () => null),
  }),
  useDeleteAsset: () => ({
    isPending: false,
    mutateAsync: jest.fn(async () => undefined),
  }),
  // The alt-text PATCH (real shape: a TanStack mutation).
  useUpdateAssetAltText: () => ({
    isPending: false,
    mutateAsync: jest.fn(async () => null),
  }),
}));

const gateHarness = QueryHooks as unknown as {
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

const WIRE_ROW = {
  id: "0f1e2d3c-4b5a-4968-8778-66554433221a",
  filename: "summer-hero.png",
  mime: "image/png",
  bytes: 1_310_720,
  width: 1280,
  height: 720,
  url: "https://cdn.example.test/assets/summer-hero.png",
  createdAt: "2026-07-01T09:00:00Z",
  altText: "",
  referencesCount: 0,
  folderId: null,
};

const FULL_COUNTS = { all: 42, recent: 9, inUse: 4, unused: 12, large: 3 };

function asset(overrides: Record<string, unknown> = {}): MobileAsset {
  return parseAsset({ ...WIRE_ROW, ...overrides })!;
}

const SETTLED = {
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  isPending: false,
  isSuccess: true,
};

/** The shape `useAssetLibrary` really resolves to: an infinite-query page set. */
function loadedPages(
  rows: readonly Record<string, unknown>[],
  counts?: unknown,
) {
  const page = parseAssetPage({
    items: rows,
    ...(counts === undefined ? {} : { counts }),
    nextCursor: null,
  });
  return {
    ...SETTLED,
    data: { pages: [page], pageParams: [null] },
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

const PENDING_LIBRARY = {
  data: undefined,
  error: null,
  fetchNextPage: jest.fn(async () => undefined),
  hasNextPage: false,
  isError: false,
  isFetching: true,
  isFetchingNextPage: false,
  isLoading: true,
  isPending: true,
  isSuccess: false,
  refetch: jest.fn(async () => ({ data: undefined })),
};

/** The shape `useAssetFolders` / `useAssetTags` / `useAssetDetail` resolve to. */
function settled<T>(data: T) {
  return { ...SETTLED, data, refetch: jest.fn(async () => ({ data })) };
}

beforeEach(() => {
  gateHarness.__resetOnlineGateForTests();
  mockHooks.library = PENDING_LIBRARY;
  mockHooks.folders = settled(parseAssetFolders({ folders: [] }));
  mockHooks.tags = settled(parseAssetTags({ tags: [] }));
  mockHooks.detail = settled(undefined);
});

describe("the asset library grid", () => {
  it("renders a bounded first frame while the library is still loading", async () => {
    const view = await render(<Assets />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    // The header proves the route module — not an error boundary — rendered.
    expect(screen.getAllByText("Images").length).toBeGreaterThan(0);
  });

  it("offers the five smart filters the server's allowlist accepts", async () => {
    await render(<Assets />, { wrapper });

    // handlers.go:289 400s anything outside this set before touching the DB.
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.getByText("In use")).toBeTruthy();
    expect(screen.getByText("Unused")).toBeTruthy();
    expect(screen.getByText("Large")).toBeTruthy();
  });

  it("shows a loaded image with its dimensions and size", async () => {
    mockHooks.library = loadedPages([WIRE_ROW], FULL_COUNTS);

    await render(<Assets />, { wrapper });

    expect(screen.getByText("summer-hero.png")).toBeTruthy();
    expect(screen.getByText("1280 × 720 · 1.3 MB")).toBeTruthy();
  });

  it("reports the TENANT total in the header, not the page length", async () => {
    // `counts` deliberately ignores filter/limit/before (repo.go:182), so one
    // row on screen and 42 in the workspace is the correct pair to show.
    mockHooks.library = loadedPages([WIRE_ROW], FULL_COUNTS);

    await render(<Assets />, { wrapper });

    expect(screen.getByText("42 images in this workspace")).toBeTruthy();
  });

  it("omits the workspace total entirely when the payload carried no counts", async () => {
    mockHooks.library = loadedPages([WIRE_ROW]);

    await render(<Assets />, { wrapper });

    expect(screen.getByText("summer-hero.png")).toBeTruthy();
    expect(screen.queryByText(/images in this workspace/)).toBeNull();
    // And no fabricated "0" beside a filter nobody measured.
    expect(screen.queryByText("0")).toBeNull();
  });

  it("renders the folder rail from the FOLDER read, not from the page", async () => {
    mockHooks.library = loadedPages([WIRE_ROW], FULL_COUNTS);
    mockHooks.folders = settled(
      parseAssetFolders({
        folders: [{ id: "f-1", name: "Brand", assetCount: 7 }],
      }),
    );
    mockHooks.tags = settled(parseAssetTags({ tags: [{ tag: "hero", count: 4 }] }));

    await render(<Assets />, { wrapper });

    expect(screen.getByLabelText("Brand, 7 images")).toBeTruthy();
    expect(screen.getByLabelText("hero, 4 images")).toBeTruthy();
  });

  it("shows no facet rails at all for a workspace with neither", async () => {
    mockHooks.library = loadedPages([WIRE_ROW], FULL_COUNTS);

    await render(<Assets />, { wrapper });

    expect(screen.queryByLabelText("Filter by folder")).toBeNull();
    expect(screen.queryByLabelText("Filter by tag")).toBeNull();
    // The smart filters survive: they need no facet data.
    expect(screen.getByText("Unused")).toBeTruthy();
  });

  it("reads an offline session as offline, never as an empty library", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    mockHooks.library = loadedPages([]);

    await render(<Assets />, { wrapper });

    expect(screen.getByText(/You're offline/)).toBeTruthy();
    expect(screen.queryByText("No images yet")).toBeNull();
  });

  it("hides the upload affordance offline rather than offering a queued upload", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    mockHooks.library = loadedPages([]);

    await render(<Assets />, { wrapper });

    // The offline queue physically cannot hold a 13 MB base64 body, so there
    // is no honest way to offer this while disconnected.
    expect(screen.queryByLabelText("Add an image to the library")).toBeNull();
  });

  it("renders the genuinely-empty library as empty, and says where images come from", async () => {
    mockHooks.library = loadedPages([], FULL_COUNTS);

    await render(<Assets />, { wrapper });

    expect(screen.getByText("No images yet")).toBeTruthy();
  });

  it("renders a failed fetch as an error, never as 'no images'", async () => {
    mockHooks.library = {
      ...PENDING_LIBRARY,
      error: new Error("boom"),
      isError: true,
      isFetching: false,
      isLoading: false,
      isPending: false,
    };

    await render(<Assets />, { wrapper });

    expect(screen.queryByText("No images yet")).toBeNull();
  });
});

describe("the tile", () => {
  it("states an unmeasured dimension as an em-dash rather than as zero", async () => {
    await render(
      <AssetTile
        asset={asset({ width: 0, height: 0, bytes: 0 })}
        baseUrl="https://api.test"
        onPress={jest.fn()}
      />,
      { wrapper },
    );

    expect(screen.getByText("— · 0 B")).toBeTruthy();
  });

  it("badges an image that live drafts still use", async () => {
    await render(
      <AssetTile
        asset={asset({ referencesCount: 3 })}
        baseUrl="https://api.test"
        onPress={jest.fn()}
      />,
      { wrapper },
    );

    // Colour alone never carries state; the pill has words and a spoken value.
    expect(screen.getByText("In use")).toBeTruthy();
    expect(screen.getByLabelText("Used by 3 live items")).toBeTruthy();
  });

  it("gives a screen reader the compacted values in full", async () => {
    await render(
      <AssetTile asset={asset()} baseUrl="https://api.test" onPress={jest.fn()} />,
      { wrapper },
    );

    expect(
      screen.getByLabelText(/summer-hero\.png\. PNG image\. 1280 × 720 pixels/),
    ).toBeTruthy();
  });

  it("falls back to a labelled placeholder instead of a blank square", async () => {
    // A relative FSStorage url with no base URL cannot be resolved at all.
    await render(
      <AssetTile
        asset={asset({ url: "/api/v1/assets/abc/blob" })}
        baseUrl={null}
        onPress={jest.fn()}
      />,
      { wrapper },
    );

    expect(screen.getByText("PNG")).toBeTruthy();
    expect(screen.getByText("Preview unavailable")).toBeTruthy();
  });
});

describe("the filter rails", () => {
  const railProps = {
    filter: "all" as const,
    onFilterChange: jest.fn(),
    counts: FULL_COUNTS,
    folders: [
      { id: "f-1", name: "Brand", createdAt: null, assetCount: 7 },
      { id: "f-2", name: "Product shots", createdAt: null, assetCount: 1 },
    ],
    folderId: null,
    onFolderChange: jest.fn(),
    tags: [{ tag: "hero", count: 4 }],
    tag: null,
    onTagChange: jest.fn(),
    sort: "newest" as const,
    onSortChange: jest.fn(),
  };

  it("offers Uncategorised alongside the real folders", async () => {
    await render(<AssetFilterRails {...railProps} />, { wrapper });

    // `folder_id=root` is a sentinel, not a folder (folders.go:58).
    expect(
      screen.getByLabelText("Uncategorised, images that are in no folder"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Brand, 7 images")).toBeTruthy();
    expect(screen.getByLabelText("Product shots, 1 image")).toBeTruthy();
  });

  it("sends the sentinel, not a uuid, when Uncategorised is chosen", async () => {
    const onFolderChange = jest.fn();
    await render(
      <AssetFilterRails {...railProps} onFolderChange={onFolderChange} />,
      { wrapper },
    );

    fireEvent.press(
      screen.getByLabelText("Uncategorised, images that are in no folder"),
    );
    expect(onFolderChange).toHaveBeenCalledWith("root");
  });

  it("clears the folder param rather than sending the 'any' chip value", async () => {
    const onFolderChange = jest.fn();
    await render(
      <AssetFilterRails
        {...railProps}
        folderId="f-1"
        onFolderChange={onFolderChange}
      />,
      { wrapper },
    );

    fireEvent.press(screen.getByLabelText("All folders, no folder filter"));
    // "any" is a UI concept; the server has no such folder and would 400.
    expect(onFolderChange).toHaveBeenCalledWith(null);
  });

  it("shows no badges at all when the payload carried no counts", async () => {
    await render(<AssetFilterRails {...railProps} counts={null} />, { wrapper });

    expect(screen.getByText("Unused")).toBeTruthy();
    expect(screen.queryByText("12")).toBeNull();
  });
});

describe("the usage block — the sentence read just before a delete", () => {
  it("names what still uses the image", async () => {
    const detail = parseAssetDetail({
      asset: WIRE_ROW,
      usage: [
        { kind: "campaign", id: "c-1", name: "July newsletter" },
        { kind: "form", id: "fm-2", name: "Footer signup" },
      ],
    });

    await render(
      <AssetUsageBlock
        usage={detail.usage}
        loading={false}
        failed={false}
        loaded
      />,
      { wrapper },
    );

    expect(screen.getByText("July newsletter")).toBeTruthy();
    // "campaign" and "form" are not interchangeable when deciding what to break.
    expect(screen.getByLabelText("Campaign: July newsletter")).toBeTruthy();
    expect(screen.getByLabelText("Form: Footer signup")).toBeTruthy();
  });

  it("says the check FAILED rather than collapsing to 'nothing uses this'", async () => {
    await render(
      <AssetUsageBlock usage={[]} loading={false} failed loaded={false} />,
      { wrapper },
    );

    expect(screen.getByText(/Couldn't check what uses this image/)).toBeTruthy();
    expect(screen.queryByText(/Nothing live uses this image/)).toBeNull();
  });

  it("says it is still checking rather than answering early", async () => {
    await render(
      <AssetUsageBlock usage={[]} loading failed={false} loaded={false} />,
      { wrapper },
    );

    expect(screen.getByText("Checking what uses this…")).toBeTruthy();
    expect(screen.queryByText(/Nothing live uses this image/)).toBeNull();
  });

  it("says nothing uses it only once that is actually known", async () => {
    await render(
      <AssetUsageBlock usage={[]} loading={false} failed={false} loaded />,
      { wrapper },
    );

    expect(
      screen.getByText("Nothing live uses this image right now."),
    ).toBeTruthy();
  });
});

describe("the detail sheet", () => {
  function sheetProps(overrides: Record<string, unknown> = {}) {
    return {
      asset: asset(),
      detail: parseAssetDetail({ asset: WIRE_ROW, usage: [] }),
      detailLoading: false,
      detailFailed: false,
      baseUrl: "https://api.test",
      canWrite: true,
      online: true,
      deleting: false,
      onClose: jest.fn(),
      onCopyUrl: jest.fn(),
      onDelete: jest.fn(),
      ...overrides,
    };
  }

  it("shows the address that would actually be pasted", async () => {
    await render(<AssetDetailSheet {...sheetProps()} />, { wrapper });

    expect(
      screen.getByText("https://cdn.example.test/assets/summer-hero.png"),
    ).toBeTruthy();
  });

  it("resolves the filesystem backend's relative url before copying it", async () => {
    const onCopyUrl = jest.fn();
    await render(
      <AssetDetailSheet
        {...sheetProps({
          asset: asset({ url: "/api/v1/assets/abc/blob" }),
          detail: parseAssetDetail({
            asset: { ...WIRE_ROW, url: "/api/v1/assets/abc/blob" },
            usage: [],
          }),
          onCopyUrl,
        })}
      />,
      { wrapper },
    );

    fireEvent.press(screen.getByLabelText("Copy image address"));
    // A relative path in a clipboard is useless on any other device.
    expect(onCopyUrl).toHaveBeenCalledWith(
      "https://api.test/api/v1/assets/abc/blob",
    );
  });

  it("disables copy rather than copying a half-formed address", async () => {
    await render(
      <AssetDetailSheet
        {...sheetProps({
          asset: asset({ url: "/api/v1/assets/abc/blob" }),
          detail: null,
          baseUrl: null,
        })}
      />,
      { wrapper },
    );

    expect(
      screen.getByLabelText("Copy image address").props.accessibilityState,
    ).toMatchObject({ disabled: true });
  });

  it("offers delete to an editor who is online", async () => {
    const onDelete = jest.fn();
    await render(<AssetDetailSheet {...sheetProps({ onDelete })} />, { wrapper });

    fireEvent.press(screen.getByLabelText("Delete image"));
    expect(onDelete).toHaveBeenCalled();
  });

  it("tells a viewer why, instead of letting them discover a 403", async () => {
    await render(<AssetDetailSheet {...sheetProps({ canWrite: false })} />, {
      wrapper,
    });

    expect(screen.queryByLabelText("Delete image")).toBeNull();
    expect(screen.getByText(/needs an editor role/)).toBeTruthy();
  });

  it("hides delete offline and says why it is not queued", async () => {
    await render(<AssetDetailSheet {...sheetProps({ online: false })} />, {
      wrapper,
    });

    expect(screen.queryByLabelText("Delete image")).toBeNull();
    expect(screen.getByText(/never queued for later/)).toBeTruthy();
  });
});

describe("the upload sheet", () => {
  it("states the server's rules before the picker opens", async () => {
    await render(
      <AssetUploadSheet
        visible
        busy={false}
        onClose={jest.fn()}
        onPickLibrary={jest.fn()}
        onPickCamera={jest.fn()}
      />,
      { wrapper },
    );

    expect(screen.getByText(/PNG, JPEG, GIF and WebP, up to 10 MB/)).toBeTruthy();
    expect(screen.getByLabelText("Choose from library")).toBeTruthy();
    expect(screen.getByLabelText("Take a photo")).toBeTruthy();
  });

  it("disables both doors while an upload is in flight", async () => {
    await render(
      <AssetUploadSheet
        visible
        busy
        onClose={jest.fn()}
        onPickLibrary={jest.fn()}
        onPickCamera={jest.fn()}
      />,
      { wrapper },
    );

    expect(
      screen.getByLabelText("Choose from library").props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(screen.getByText(/Uploading…/)).toBeTruthy();
  });
});
