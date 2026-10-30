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
  listAssets: vi.fn(),
  listTags: vi.fn(),
  listFolders: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiSendTimeAssets: {
    listAssets: mocks.listAssets,
    listAssetTags: mocks.listTags,
    listAssetFolders: mocks.listFolders,
  },
}));
vi.mock("../../lib/store", () => ({
  useCanWrite: () => true,
  useMe: () => ({ user: "user-1", tenant: "tenant-1" }),
}));
vi.mock("../../components/library/AssetThumb", () => ({
  AssetThumb: ({ alt }: { alt: string }) => <div role="img" aria-label={alt} />,
}));
vi.mock("../../lib/heroAssets", () => ({ HERO: { assets: "assets.webp" } }));

import { Assets } from "../../pages/Assets";

const validAsset = {
  id: "00000000-0000-4000-8000-000000000002",
  tenantId: "00000000-0000-4000-8000-000000000001",
  filename: "hero.png",
  mime: "image/png",
  bytes: 128,
  url: "https://cdn.example.test/hero.png",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  version: 1,
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
  mocks.listAssets.mockReset();
  mocks.listTags.mockReset().mockResolvedValue({ data: { tags: [] } });
  mocks.listFolders.mockReset().mockResolvedValue({ data: { folders: [] } });
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

describe("Assets runtime maturity", () => {
  it("announces a dedicated initial catalog loading state", () => {
    mocks.listAssets.mockReturnValue(new Promise(() => undefined));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Assets />));

    const loading = container.querySelector<HTMLElement>(
      ".lib-catalog-loading[role=status]",
    );
    expect(loading?.getAttribute("aria-busy")).toBe("true");
    expect(loading?.textContent).toContain("Loading verified images");
    expect(
      container.querySelectorAll(".lib-catalog-skeleton-card"),
    ).toHaveLength(6);
    expect(container.querySelector(".lib-catalog-stage")).toBeNull();
  });

  it("retains verified rows and marks them stale when a malformed refresh succeeds", async () => {
    let resolveRefresh: ((value: unknown) => void) | undefined;
    mocks.listAssets
      .mockResolvedValueOnce({
        data: { items: [validAsset], counts, nextCursor: null },
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
      );
    await renderAndLoad();
    expect(container?.textContent).toContain("hero.png");
    expect(
      container?.querySelector(".lib-catalog-stage")?.hasAttribute("inert"),
    ).toBe(false);

    const search = container?.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "hero");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(container?.textContent).toContain(
      "Refreshing verified results. Asset actions will resume",
    );
    expect(
      container?.querySelector(".lib-catalog-stage")?.hasAttribute("inert"),
    ).toBe(true);

    await act(async () => {
      resolveRefresh?.({
        data: {
          items: [{ ...validAsset, bytes: "bad" }],
          counts,
          nextCursor: null,
        },
      });
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("hero.png");
    expect(container?.textContent).toContain(
      "Previously verified results remain visible as a read-only snapshot",
    );
    expect(container?.textContent).toContain(
      "Asset actions are paused until Retry confirms the current catalog",
    );
    expect(
      container?.querySelector(".lib-catalog-stage")?.hasAttribute("inert"),
    ).toBe(true);
  });
});
