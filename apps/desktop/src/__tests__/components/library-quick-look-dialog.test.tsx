// @vitest-environment happy-dom

import axe from "axe-core";
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

import type { Asset, AssetReferrer } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  moveFolder: vi.fn(),
  clipboard: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiSendTimeAssets: {
    patchAsset: mocks.patch,
    addAssetTag: mocks.addTag,
    removeAssetTag: mocks.removeTag,
    moveAssetToFolder: mocks.moveFolder,
  },
}));

vi.mock("../../lib/store", () => ({ useCanWrite: () => true }));
vi.mock("../../lib/clipboard", () => ({ writeClipboardText: mocks.clipboard }));
vi.mock("../../lib/tauri", () => ({ tauriApi: { openUrl: vi.fn() } }));
vi.mock("../../components/library/AssetThumb", () => ({
  AssetThumb: ({
    alt,
    allowAnimation,
  }: {
    alt: string;
    allowAnimation?: boolean;
  }) => (
    <div
      role="img"
      aria-label={alt}
      data-testid="asset-thumb"
      data-allow-animation={allowAnimation ? "true" : "false"}
    />
  ),
}));

import { LibraryQuickLook } from "../../components/library/LibraryQuickLook";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.clipboard.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "confirm");
});

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    tenantId: "00000000-0000-4000-8000-000000000001",
    filename: "hero.png",
    mime: "image/png",
    bytes: 128,
    width: 1200,
    height: 600,
    url: "https://cdn.example.test/hero.png",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    version: 1,
    altText: "Original hero",
    tags: [],
    ...overrides,
  };
}

function render(
  options: {
    asset?: Asset;
    usage?: AssetReferrer[];
    onClose?: () => void;
    onPrev?: () => void;
    onNext?: () => void;
    onAltTextChanged?: (id: string, altText: string) => void;
    onTagsChanged?: (id: string, tags: string[]) => void;
  } = {},
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <LibraryQuickLook
        asset={options.asset ?? asset()}
        usage={options.usage ?? []}
        index={1}
        total={3}
        onPrev={options.onPrev ?? vi.fn()}
        onNext={options.onNext ?? vi.fn()}
        onClose={options.onClose ?? vi.fn()}
        onAltTextChanged={options.onAltTextChanged ?? vi.fn()}
        onRequestDelete={vi.fn()}
        onTagsChanged={options.onTagsChanged}
      />,
    ),
  );
}

function key(
  target: EventTarget,
  value: string,
  options: KeyboardEventInit = {},
): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: value,
        ...options,
      }),
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => Promise.resolve());
}

function fill(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("LibraryQuickLook dialog", () => {
  it("owns focus, naming, IME-safe bounded navigation, and an axe-clean tree", async () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render({ onPrev, onNext });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    expect(
      document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("hero.png");
    expect(
      document.getElementById(dialog?.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("Asset 2 of 3: hero.png");
    key(window, "ArrowLeft", { isComposing: true });
    expect(onPrev).not.toHaveBeenCalled();
    key(window, "ArrowLeft");
    expect(onPrev).toHaveBeenCalledTimes(1);
    const alt = document.querySelector<HTMLInputElement>(
      "#alt-00000000-0000-4000-8000-000000000002",
    );
    act(() => alt?.focus());
    key(alt!, "ArrowRight");
    expect(onNext).not.toHaveBeenCalled();
    const result = await axe.run(dialog!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("never blur-saves and gives Tab-to-Cancel an explicit, focus-stable path", () => {
    render();
    const alt = document.querySelector<HTMLInputElement>(
      "#alt-00000000-0000-4000-8000-000000000002",
    )!;
    fill(alt, "Draft that must not save on blur");
    act(() => {
      alt.focus();
      alt.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    key(alt, "Tab");
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Cancel changes")!;
    act(() => {
      cancel.focus();
      cancel.click();
    });
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(alt.value).toBe("Original hero");
    expect(document.activeElement).toBe(alt);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Alt text changes cancelled",
    );
  });

  it("close, backdrop, Escape, and navigation never imply a save", () => {
    const onClose = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: confirm,
    });
    render({ onClose, onPrev, onNext });
    const alt = document.querySelector<HTMLInputElement>(
      "#alt-00000000-0000-4000-8000-000000000002",
    )!;
    fill(alt, "Unsaved explicit draft");

    const backdrop = document.querySelector<HTMLElement>(
      ".lib-quicklook-backdrop",
    )!;
    act(() => {
      backdrop.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 12,
          pointerType: "touch",
        }),
      );
      backdrop.dispatchEvent(
        new PointerEvent("pointercancel", {
          bubbles: true,
          pointerId: 12,
          pointerType: "touch",
        }),
      );
    });
    expect(confirm).not.toHaveBeenCalled();

    key(window, "Escape");
    act(() => {
      backdrop.click();
      document
        .querySelector<HTMLButtonElement>(".lib-quicklook-close")
        ?.click();
      document
        .querySelector<HTMLButtonElement>(".lib-quicklook-nav.prev")
        ?.click();
      document
        .querySelector<HTMLButtonElement>(".lib-quicklook-nav.next")
        ?.click();
    });

    expect(confirm).toHaveBeenCalledTimes(3);
    expect(onClose).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("blocks keyboard and completed-pointer dismissal while an explicit save is unsettled", async () => {
    let resolve!: (value: { data: Asset }) => void;
    mocks.patch.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const onClose = vi.fn();
    render({ onClose });
    const alt = document.querySelector<HTMLInputElement>(
      "#alt-00000000-0000-4000-8000-000000000002",
    )!;
    fill(alt, "Updated hero");
    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Save alt text")
        ?.click();
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[role="dialog"]')?.getAttribute("aria-busy"),
    ).toBe("true");
    key(window, "Escape");
    act(() => {
      const backdrop = document.querySelector<HTMLElement>(
        ".lib-quicklook-backdrop",
      )!;
      backdrop.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 9 }),
      );
      backdrop.dispatchEvent(
        new PointerEvent("pointercancel", { bubbles: true, pointerId: 9 }),
      );
      backdrop.click();
      document
        .querySelector<HTMLButtonElement>(".lib-quicklook-close")
        ?.click();
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      resolve({ data: asset({ altText: "Updated hero" }) });
      await Promise.resolve();
    });
    await settle();
    expect(
      document.querySelector<HTMLButtonElement>(".lib-quicklook-close")
        ?.disabled,
    ).toBe(false);
    expect(document.activeElement).toBe(alt);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Alt text saved",
    );
    act(() =>
      document.querySelector<HTMLElement>(".lib-quicklook-backdrop")?.click(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the tag editor after an acknowledged removal", async () => {
    mocks.removeTag.mockResolvedValue({
      data: {
        ok: true,
        id: "00000000-0000-4000-8000-000000000002",
        version: 2,
      },
    });
    render({ asset: asset({ tags: ["hero", "sale"] }) });
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove tag hero"]',
        )
        ?.click();
    });
    await settle();
    await settle();
    expect(document.activeElement).toBe(
      document.querySelector<HTMLInputElement>(
        "#tag-00000000-0000-4000-8000-000000000002",
      ),
    );
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "hero removed. 1 tag remains",
    );
  });

  it("rejects a structurally valid alt acknowledgement that does not converge", async () => {
    const onAltTextChanged = vi.fn();
    mocks.patch.mockResolvedValue({
      data: asset({ altText: "Different server value" }),
    });
    render({ onAltTextChanged });
    const alt = document.querySelector<HTMLInputElement>(
      "#alt-00000000-0000-4000-8000-000000000002",
    )!;
    fill(alt, "Requested exact value");
    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Save alt text")
        ?.click();
    });
    await settle();
    await settle();
    expect(onAltTextChanged).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(alt);
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Save alt text",
      ),
    ).toBe(true);
  });

  it("keeps animated GIFs paused until explicit play and offers an explicit stop", () => {
    render({
      asset: asset({
        filename: "launch.gif",
        mime: "image/gif",
        url: "https://cdn.example.test/launch.gif",
      }),
    });
    expect(document.querySelector('[data-testid="asset-thumb"]')).toBeNull();
    expect(document.body.textContent).toContain("Animated image paused");
    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Play animation")
        ?.click();
    });
    expect(
      document.querySelector('[data-testid="asset-thumb"]'),
    ).not.toBeNull();
    expect(
      document
        .querySelector('[data-testid="asset-thumb"]')
        ?.getAttribute("data-allow-animation"),
    ).toBe("true");
    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Stop animation")
        ?.click();
    });
    expect(document.querySelector('[data-testid="asset-thumb"]')).toBeNull();
  });

  it("describes references as reported uses without asserting draft state", () => {
    render({
      usage: [
        {
          kind: "form",
          id: "published-form",
          name: "Published signup",
        },
      ],
    });
    expect(document.body.textContent).toContain("1 reported use:");
    expect(document.body.textContent).not.toContain("live draft");
  });
});
