// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  canWrite: true,
  listAssets: vi.fn(),
  listTags: vi.fn(),
  listFolders: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  createFolder: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  registerGuard: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiSendTimeAssets: {
    listAssets: mocks.listAssets,
    listAssetTags: mocks.listTags,
    listAssetFolders: mocks.listFolders,
    createAssetFolder: mocks.createFolder,
    renameAssetFolder: mocks.renameFolder,
    deleteAssetFolder: mocks.deleteFolder,
  },
}));
vi.mock("../../lib/store", () => ({
  useCanWrite: () => mocks.canWrite,
  useMe: () => ({ user: "user-1", tenant: "tenant-1" }),
}));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
  },
}));
vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: mocks.registerGuard,
}));
vi.mock("../../components/library/AssetThumb", () => ({
  AssetThumb: ({ alt }: { alt: string }) => <div role="img" aria-label={alt} />,
}));
vi.mock("../../lib/heroAssets", () => ({
  HERO: { assets: "assets.webp" },
}));

import { Assets } from "../../pages/Assets";

const folder = {
  id: "00000000-0000-4000-8000-000000000003",
  tenantId: "00000000-0000-4000-8000-000000000001",
  name: "Heroes",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  version: 1,
  assetCount: 2,
};
const asset = {
  id: "00000000-0000-4000-8000-000000000002",
  tenantId: "00000000-0000-4000-8000-000000000001",
  filename: "hero.png",
  mime: "image/png",
  bytes: 128,
  url: "https://cdn.example.test/hero.png",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  version: 1,
  folderId: folder.id,
};
const counts = { all: 1, recent: 1, inUse: 0, unused: 1, large: 0 };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  class TestResizeObserver {
    observe(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.canWrite = true;
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.listAssets.mockResolvedValue({
    data: { items: [asset], counts, nextCursor: null },
  });
  mocks.listTags.mockResolvedValue({ data: { tags: [] } });
  mocks.listFolders.mockResolvedValue({ data: { folders: [folder] } });
  mocks.registerGuard.mockReturnValue(() => undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

async function renderAndLoad(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Assets />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(
    container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

function change(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function selectFolder(): Promise<void> {
  act(() => buttonByLabel("Heroes, 2 assets").click());
  await act(async () => Promise.resolve());
}

describe("Assets folder management", () => {
  it("gives the new-folder field a persistent visible label", async () => {
    await renderAndLoad();
    act(() => buttonByText("+ New folder").click());

    const input = container?.querySelector<HTMLInputElement>(
      'input[placeholder^="For example:"]',
    );
    const label = input?.closest("label");
    expect(input).not.toBeNull();
    expect(label?.textContent).toContain("Folder name");
  });

  it("reveals scoped accessible actions only for a selected real folder and protects a dirty rename", async () => {
    await renderAndLoad();
    expect(
      container?.querySelector('[aria-label="Heroes folder actions"]'),
    ).toBeNull();

    await selectFolder();
    expect(
      container?.querySelector('[aria-label="Heroes folder actions"]'),
    ).not.toBeNull();

    act(() => buttonByLabel("Rename folder Heroes").click());
    const input = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Rename folder name"]',
    );
    expect(input).not.toBeNull();
    change(input!, "Lifecycle heroes");

    const guard = mocks.registerGuard.mock.calls
      .map(
        ([candidate]) => candidate as { id?: string; inspect?: () => unknown },
      )
      .filter((candidate) => candidate.id === "asset-folder-management")
      .at(-1);
    expect(guard?.inspect?.()).toMatchObject({ level: "warning" });

    act(() => buttonByLabel("Close").click());
    expect(container?.textContent).toContain("Discard the new folder name?");
    expect(container?.textContent).toContain("will keep its current name");
    act(() => buttonByText("Cancel").click());
    expect(
      container?.querySelector('input[aria-label="Rename folder name"]'),
    ).not.toBeNull();
  });

  it("serializes rename, rejects mismatched success data, retains the draft, then applies an exact response", async () => {
    await renderAndLoad();
    await selectFolder();
    act(() => buttonByLabel("Rename folder Heroes").click());
    const input = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Rename folder name"]',
    );
    change(input!, "Campaign heroes");

    let resolveRename: ((value: unknown) => void) | undefined;
    mocks.renameFolder.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRename = resolve;
      }),
    );
    act(() => buttonByText("Save name").click());
    expect(mocks.renameFolder).toHaveBeenCalledTimes(1);
    expect(mocks.renameFolder).toHaveBeenCalledWith(
      folder.id,
      "Campaign heroes",
      folder.version,
    );
    expect(buttonByText("Renaming…").disabled).toBe(true);

    await act(async () => {
      resolveRename?.({
        data: {
          ...folder,
          id: "00000000-0000-4000-8000-000000000099",
          name: "Campaign heroes",
          version: 2,
        },
      });
      await Promise.resolve();
    });
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("different folder or name"),
    );
    expect(
      container?.querySelector('input[aria-label="Rename folder name"]'),
    ).not.toBeNull();

    mocks.renameFolder.mockResolvedValueOnce({
      data: { ...folder, name: "Campaign heroes", version: 2 },
    });
    await act(async () => buttonByText("Save name").click());
    expect(container?.textContent).toContain("Campaign heroes");
    expect(
      container?.querySelector('input[aria-label="Rename folder name"]'),
    ).toBeNull();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Folder renamed to “Campaign heroes”",
    );
  });

  it("reviews non-destructive folder deletion, requires ok true, and moves the active filter to Uncategorised", async () => {
    await renderAndLoad();
    await selectFolder();
    act(() => buttonByLabel("Delete folder Heroes").click());

    expect(container?.textContent).toContain("2 assets");
    expect(container?.textContent).toContain(
      "contained images are moved to Uncategorised and are never deleted",
    );

    mocks.deleteFolder.mockResolvedValueOnce({ data: { ok: false } });
    await act(async () => buttonByText("Delete folder").click());
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("canonical id and positive version"),
    );
    expect(container?.textContent).toContain("Review what happens to “Heroes”");

    let resolveDelete: ((value: unknown) => void) | undefined;
    mocks.deleteFolder.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelete = resolve;
      }),
    );
    act(() => buttonByText("Delete folder").click());
    expect(mocks.deleteFolder).toHaveBeenCalledTimes(2);
    expect(buttonByText("Working…").disabled).toBe(true);
    const busyGuard = mocks.registerGuard.mock.calls
      .map(
        ([candidate]) => candidate as { id?: string; inspect?: () => unknown },
      )
      .filter((candidate) => candidate.id === "asset-folder-management")
      .at(-1);
    expect(busyGuard?.inspect?.()).toMatchObject({ level: "blocking" });
    await act(async () => {
      resolveDelete?.({
        data: { ok: true, id: folder.id, version: folder.version + 1 },
      });
      await Promise.resolve();
    });
    expect(
      buttonByLabel(
        "Uncategorised, show only assets not filed in a folder",
      ).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      container?.querySelector('[aria-label="Heroes folder actions"]'),
    ).toBeNull();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Folder “Heroes” deleted; its assets are now Uncategorised",
    );
  });

  it("disables an open destructive review after a live permission downgrade", async () => {
    await renderAndLoad();
    await selectFolder();
    act(() => buttonByLabel("Delete folder Heroes").click());

    mocks.canWrite = false;
    act(() => root?.render(<Assets />));

    expect(container?.textContent).toContain(
      "Your current role can view folders but can't delete them",
    );
    expect(buttonByText("Delete folder").disabled).toBe(true);
    expect(
      container?.querySelector('[aria-label="Heroes folder actions"]'),
    ).toBeNull();
  });
});
