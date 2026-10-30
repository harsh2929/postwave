// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactNode } from "react";
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
  onPick: vi.fn(),
  pickImportFiles: vi.fn(),
  toastError: vi.fn(),
  uploadAsset: vi.fn(),
  canWrite: true,
}));

vi.mock("../../lib/api-client", () => ({
  apiSendTimeAssets: {
    listAssets: mocks.listAssets,
    uploadAsset: mocks.uploadAsset,
  },
}));
vi.mock("../../lib/file-transfer", () => ({
  beginUploadTransfer: () => ({
    complete: vi.fn(),
    fail: vi.fn(),
    progress: vi.fn(),
  }),
  fileToBase64: vi.fn().mockResolvedValue("cG5n"),
  pickImportFiles: mocks.pickImportFiles,
}));
vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: () => vi.fn(),
}));
vi.mock("../../lib/store", () => ({ useCanWrite: () => mocks.canWrite }));
vi.mock("../../components/library/AssetThumb", () => ({
  AssetThumb: ({ alt }: { alt: string }) => <span>{alt}</span>,
}));
vi.mock("../../components/Modal", () => ({
  Modal: ({
    children,
    closeDisabled,
    open,
    title,
  }: {
    children: ReactNode;
    closeDisabled?: boolean;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <div
        role="dialog"
        aria-label={title}
        data-close-disabled={closeDisabled ? "true" : "false"}
      >
        {children}
      </div>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));

import { AssetPicker } from "../../components/library/AssetPicker";

const tenantId = "11111111-1111-4111-8111-111111111111";
const searchResult = {
  id: "22222222-2222-4222-8222-222222222222",
  tenantId,
  filename: "needle-logo.png",
  mime: "image/png",
  bytes: 128,
  url: "https://cdn.example.test/needle-logo.png",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  version: 1,
};
const uploadedAsset = {
  id: "33333333-3333-4333-8333-333333333333",
  tenantId,
  filename: "different-banner.png",
  mime: "image/png",
  bytes: 256,
  url: "https://cdn.example.test/different-banner.png",
  createdAt: "2026-07-22T00:01:00.000Z",
  updatedAt: "2026-07-22T00:01:00.000Z",
  version: 1,
};
const secondAsset = {
  ...searchResult,
  id: "44444444-4444-4444-8444-444444444444",
  filename: "needle-footer.png",
  url: "https://cdn.example.test/needle-footer.png",
};
const thirdAsset = {
  ...searchResult,
  id: "55555555-5555-4555-8555-555555555555",
  filename: "needle-social.png",
  url: "https://cdn.example.test/needle-social.png",
};
const counts = { all: 3, recent: 3, inUse: 0, unused: 3, large: 0 };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.listAssets.mockReset().mockResolvedValue({
    data: { items: [searchResult], counts },
  });
  mocks.uploadAsset.mockReset().mockResolvedValue({ data: uploadedAsset });
  mocks.pickImportFiles.mockReset().mockResolvedValue({
    ok: true,
    files: [new File(["png"], uploadedAsset.filename, { type: "image/png" })],
    source: "native",
  });
  mocks.toastError.mockReset();
  mocks.onPick.mockReset();
  mocks.canWrite = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

function button(name: string): HTMLButtonElement {
  const match = [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Missing button: ${name}`);
  return match;
}

describe("AssetPicker upload visibility", () => {
  it("keeps a successful non-matching upload visible, selected, and insertable", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AssetPicker
          open
          initialQuery="needle"
          onClose={vi.fn()}
          onPick={mocks.onPick}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    await act(async () => {
      button("Upload image…").click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(container.textContent).toContain(uploadedAsset.filename);
    expect(
      container.querySelector(".asset-picker-tile.is-selected")?.textContent,
    ).toContain(uploadedAsset.filename);
    expect(button("Insert").disabled).toBe(false);

    act(() => button("Insert").click());
    expect(mocks.onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: uploadedAsset.id }),
    );
  });

  it("exposes a named single-select listbox and supports roving Arrow, Home, and End focus", async () => {
    mocks.listAssets.mockResolvedValue({
      data: { items: [searchResult, secondAsset, thirdAsset], counts },
    });
    mountPicker();
    await loadPicker();

    const listbox = container?.querySelector('[role="listbox"]');
    expect(listbox?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(container?.querySelector("label")?.textContent).toBe(
      "Search Library",
    );
    expect(container?.querySelector("label")?.htmlFor).toBe(
      container?.querySelector<HTMLInputElement>('input[type="search"]')?.id,
    );
    const options = () => [
      ...(container?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        []),
    ];
    expect(options()).toHaveLength(3);
    expect(options().filter((option) => option.tabIndex === 0)).toHaveLength(1);
    expect(options()[0]?.getAttribute("aria-selected")).toBe("false");

    act(() => options()[0]?.focus());
    await pressKey(options()[0]!, "ArrowRight");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(options()[1]?.tabIndex).toBe(0);

    await pressKey(options()[1]!, "ArrowDown");
    expect(options()[2]?.getAttribute("aria-selected")).toBe("true");
    await pressKey(options()[2]!, "ArrowLeft");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");

    await pressKey(options()[1]!, "End");
    expect(options()[2]?.getAttribute("aria-selected")).toBe("true");
    await pressKey(options()[2]!, "Home");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    await pressKey(options()[0]!, "ArrowUp");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    act(() => options()[2]?.focus());
    await pressKey(options()[2]!, "Enter");
    expect(options()[2]?.getAttribute("aria-selected")).toBe("true");
    act(() => options()[1]?.focus());
    await pressKey(options()[1]!, " ");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(button("Insert").disabled).toBe(false);

    vi.useRealTimers();
    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    vi.useFakeTimers();
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("blocks stale result actions while a new query refresh is pending", async () => {
    let resolveRefresh: ((value: unknown) => void) | null = null;
    const refresh = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    mocks.listAssets
      .mockResolvedValueOnce({ data: { items: [searchResult], counts } })
      .mockReturnValueOnce(refresh);
    mountPicker();
    await loadPicker();
    act(() =>
      container?.querySelector<HTMLButtonElement>('[role="option"]')?.click(),
    );
    expect(button("Insert").disabled).toBe(false);

    const input = container?.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    if (!input) throw new Error("Missing search input");
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.bind(input);
      valueSetter?.("new query");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Insert").disabled).toBe(true);
    expect(
      container?.querySelector<HTMLButtonElement>('[role="option"]')?.disabled,
    ).toBe(true);
    expect(container?.textContent).toContain(
      "Previous results are visible but unavailable",
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));

    await act(async () => {
      resolveRefresh?.({
        data: {
          items: [{ ...uploadedAsset, filename: "new-query.png" }],
          counts,
        },
      });
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("new-query.png");
    expect(container?.textContent).not.toContain(searchResult.filename);
  });

  it("renders a hard load error rather than an empty state and retries explicitly", async () => {
    mocks.listAssets
      .mockResolvedValueOnce({ error: { message: "Library offline" } })
      .mockResolvedValueOnce({ data: { items: [searchResult], counts } });
    mountPicker();
    await loadPicker();
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load the Library",
    );
    expect(container?.textContent).not.toContain("Your Library is empty");
    expect(container?.querySelector('[role="listbox"]')).toBeNull();

    act(() => button("Retry").click());
    await loadPicker();
    expect(container?.querySelector('[role="alert"]')).toBeNull();
    expect(container?.querySelectorAll('[role="option"]')).toHaveLength(1);
  });

  it("reports native picker rejection and truthfully blocks closing while upload is in flight", async () => {
    mountPicker();
    await loadPicker();
    mocks.pickImportFiles.mockRejectedValueOnce(
      new Error("native dialog unavailable"),
    );
    await act(async () => {
      button("Upload image…").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("native dialog unavailable"),
    );

    let resolveUpload: ((value: unknown) => void) | null = null;
    mocks.uploadAsset.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    await act(async () => {
      button("Upload image…").click();
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
    expect(
      container
        ?.querySelector('[role="dialog"]')
        ?.getAttribute("data-close-disabled"),
    ).toBe("true");
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => {
      resolveUpload?.({ data: uploadedAsset });
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
  });

  it("explains read-only capability and omits upload controls", async () => {
    mocks.canWrite = false;
    mountPicker();
    await loadPicker();
    expect(container?.textContent).toContain(
      "Your role can choose existing images but cannot upload new ones.",
    );
    expect(
      [...(container?.querySelectorAll("button") ?? [])].some((candidate) =>
        candidate.textContent?.includes("Upload"),
      ),
    ).toBe(false);
  });
});

function mountPicker(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AssetPicker
        open
        initialQuery="needle"
        onClose={vi.fn()}
        onPick={mocks.onPick}
      />,
    );
  });
}

async function loadPicker(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

async function pressKey(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await vi.advanceTimersByTimeAsync(20);
  });
}
