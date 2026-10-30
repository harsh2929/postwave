/**
 * The asset writes are version-gated, and an affordance that cannot send the
 * version is WITHHELD rather than offered.
 *
 * WHY A RENDER TEST AND NOT ONLY A NODE ONE. The node tests pin the request
 * bodies and the policy sentences; what only a render can pin is the decision
 * that comes BEFORE the request — whether a button exists at all. Every write
 * under /api/v1/assets answers 428 `expected_version_required` without a
 * positive `expected_version` (412 `stale_version` when it no longer matches),
 * and the only honest source of that number is the row on screen. When the row
 * carries none there are exactly two dishonest options: disable the button and
 * say nothing, or guess a number — which either 428s immediately or, if it
 * happens to be right, silently overwrites a colleague's edit. The third
 * option, taken here, is to withhold the control and say why.
 *
 * The three surfaces that make that decision are all pinned below: the screen
 * (which owns the policy), the detail sheet (delete + organise) and the
 * organise sheet's Manage strip (rename + delete, gated on the FOLDER's own
 * version rather than the asset's).
 *
 * `render` / `fireEvent` are awaited throughout — in this tree they resolve
 * promises, and a missed `await` fails the whole file with "render function has
 * not been called", which reads like a component crash.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { AssetDetailSheet } from "@/components/assets/AssetDetailSheet";
import { parseAsset, parseAssetDetail, parseAssetPage } from "@/lib/assetLibrary";

import { AssetOrganizeSheet } from "../src/components/assets/AssetOrganizeSheet";
import Assets from "../app/(tabs)/assets";

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
  useUpdateAssetAltText: () => ({
    isPending: false,
    mutateAsync: jest.fn(async () => null),
  }),
}));

const gateHarness = QueryHooks as unknown as {
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

/** The row as the server really sends it — `version` included. */
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
  version: 4,
};

const SETTLED = {
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  isPending: false,
  isSuccess: true,
};

function loadedPages(rows: readonly Record<string, unknown>[]) {
  return {
    ...SETTLED,
    data: {
      pages: [parseAssetPage({ items: rows, nextCursor: null })],
      pageParams: [null],
    },
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

function settledList(data: unknown) {
  return { ...SETTLED, data, refetch: jest.fn(async () => ({ data: undefined })) };
}

beforeEach(() => {
  mockHooks.library = loadedPages([WIRE_ROW]);
  mockHooks.folders = settledList([]);
  mockHooks.tags = settledList([]);
  mockHooks.detail = { ...SETTLED, data: null };
});

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  jest.clearAllMocks();
});

describe("the screen decides, from the row, whether a write can be offered", () => {
  it("offers delete and organise for a row that carries its version", async () => {
    await render(<Assets />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/summer-hero\.png/));

    expect(screen.getByLabelText("Delete image")).toBeTruthy();
    expect(screen.getByLabelText("Organise — folder and tags")).toBeTruthy();
  });

  it("withholds both — and says why — for a row that carries none", async () => {
    // A version-less payload is the only case an editor on a live connection
    // can still be refused, so this is the branch that would otherwise ship a
    // button whose DELETE the server answers 428 for, every single time.
    const { version: _dropped, ...noVersion } = WIRE_ROW;
    mockHooks.library = loadedPages([noVersion]);

    await render(<Assets />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/summer-hero\.png/));

    expect(screen.queryByLabelText("Delete image")).toBeNull();
    expect(screen.queryByLabelText("Organise — folder and tags")).toBeNull();
    expect(screen.getByText(/version every change is checked against/)).toBeTruthy();
  });

  it("prefers the detail read's row, so a refreshed version re-opens the verbs", async () => {
    // The grid row is the stale one here; `GET /assets/{id}` is authoritative
    // and its version is the number the delete would actually send.
    const { version: _dropped, ...noVersion } = WIRE_ROW;
    mockHooks.library = loadedPages([noVersion]);
    mockHooks.detail = {
      ...SETTLED,
      data: parseAssetDetail({ asset: WIRE_ROW, usage: [] }),
    };

    await render(<Assets />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/summer-hero\.png/));

    expect(screen.getByLabelText("Delete image")).toBeTruthy();
  });
});

describe("the detail sheet renders exactly what it is handed", () => {
  function sheetProps(overrides: Record<string, unknown> = {}) {
    return {
      asset: parseAsset(WIRE_ROW),
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

  it("says nothing about blocked writes when the write is on offer", async () => {
    await render(<AssetDetailSheet {...sheetProps()} />, { wrapper });
    expect(screen.getByLabelText("Delete image")).toBeTruthy();
    expect(screen.queryByText(/version every change is checked against/)).toBeNull();
  });

  it("reads a withheld onDelete as the version block, not as a missing button", async () => {
    await render(<AssetDetailSheet {...sheetProps({ onDelete: undefined })} />, {
      wrapper,
    });
    expect(screen.queryByLabelText("Delete image")).toBeNull();
    expect(screen.getByText(/could silently overwrite a teammate/)).toBeTruthy();
  });

  it("keeps the role reason ahead of the version reason", async () => {
    // A viewer must be told about the role, which they can do something about,
    // rather than about an optimistic-concurrency token they cannot.
    await render(
      <AssetDetailSheet {...sheetProps({ canWrite: false, onDelete: undefined })} />,
      { wrapper },
    );
    expect(screen.getByText(/needs an editor role/)).toBeTruthy();
    expect(screen.queryByText(/version every change is checked against/)).toBeNull();
  });
});

describe("the organise sheet gates folder rename and delete on the FOLDER's version", () => {
  function sheet(
    folders: readonly Record<string, unknown>[],
    onMove: (folderId: string | null, folderName: string | null) => void = jest.fn(),
  ) {
    return (
      <AssetOrganizeSheet
        visible
        onClose={jest.fn()}
        assetId="a1"
        assetFilename="hero.png"
        currentFolderId={null}
        folders={folders as never}
        foldersLoading={false}
        foldersFailed={false}
        tags={["hero"]}
        tagsLoading={false}
        tagsFailed={false}
        busy={false}
        onMove={onMove}
        onCreateFolder={jest.fn()}
        onRenameFolder={jest.fn()}
        onDeleteFolder={jest.fn()}
        onAddTag={jest.fn()}
        onRemoveTag={jest.fn()}
      />
    );
  }

  it("offers rename and delete for a folder that carries its version", async () => {
    const result = await render(
      sheet([{ id: "f1", name: "Newsletters", createdAt: null, assetCount: 3, version: 2 }]),
    );
    await fireEvent.press(result.getByLabelText("Manage folders — rename or delete"));
    await fireEvent.press(result.getByLabelText("Newsletters"));

    expect(result.getByLabelText("New name for the Newsletters folder")).toBeTruthy();
    expect(result.getByLabelText("Delete folder")).toBeTruthy();
  });

  it("withholds both for a folder that carries none, and says so in their place", async () => {
    const result = await render(
      sheet([{ id: "f1", name: "Newsletters", createdAt: null, assetCount: 3 }]),
    );
    await fireEvent.press(result.getByLabelText("Manage folders — rename or delete"));
    await fireEvent.press(result.getByLabelText("Newsletters"));

    expect(result.queryByLabelText("New name for the Newsletters folder")).toBeNull();
    expect(result.queryByLabelText("Delete folder")).toBeNull();
    expect(result.getByText(/Renaming and deleting this folder are unavailable/)).toBeTruthy();
  });

  it("leaves filing the image into that folder alone — a different row's version", async () => {
    // The move writes the ASSET row, so a folder carrying no version of its
    // own is still a perfectly valid destination. Withholding it too would be
    // the gate spreading past the write it actually guards.
    const onMove = jest.fn();
    const result = await render(
      sheet([{ id: "f1", name: "Newsletters", createdAt: null, assetCount: 3 }], onMove),
    );
    await fireEvent.press(result.getByLabelText("Newsletters"));
    expect(onMove).toHaveBeenCalledWith("f1", "Newsletters");
  });
});
