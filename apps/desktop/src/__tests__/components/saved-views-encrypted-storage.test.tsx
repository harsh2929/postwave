// @vitest-environment happy-dom

import { act, type ReactElement, StrictMode } from "react";
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

import { SavedViewsMenu } from "../../components/analytics/SavedViewsMenu";
import {
  SAVED_VIEWS_VAULT_NAMESPACE,
  sanitizeSavedViews,
  type SavedView,
} from "../../components/analytics/saved-views-storage";
import { sensitiveLocalVaultKey } from "../../lib/sensitive-local-data";
import { vaultGetJSON, vaultSetJSON } from "../../lib/secure-vault";

const SCOPE = "cccccccccccccccc";
const VAULT_PREFIX = "postwave.desktop.vault.v1:";
const LEGACY_KEY = `postwave.analytics.saved-views.v1:${SCOPE}`;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function logicalKey(): string {
  return sensitiveLocalVaultKey(SAVED_VIEWS_VAULT_NAMESPACE, SCOPE);
}

function physicalKey(): string {
  return `${VAULT_PREFIX}${logicalKey()}`;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  localStorage.clear();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function menu(): ReactElement {
  return (
    <SavedViewsMenu
      current={{ range: "30d", vsPrevious: true }}
      onApply={vi.fn()}
      storageScope={SCOPE}
    />
  );
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

function setInput(value: string): void {
  const input = document.querySelector<HTMLInputElement>('input[type="text"]');
  if (!input) throw new Error("Missing saved-view name input");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => Promise.resolve());
    }
  }
  throw failure;
}

async function seed(views: SavedView[]): Promise<void> {
  await vaultSetJSON(logicalKey(), { version: 1, value: views });
}

async function stored(): Promise<SavedView[]> {
  const record = await vaultGetJSON<{ version: 1; value: SavedView[] }>(
    logicalKey(),
  );
  return record?.value ?? [];
}

async function openReady(): Promise<void> {
  click(document.querySelector('button[aria-haspopup="dialog"]'));
  await waitFor(() =>
    expect(
      document
        .querySelector<HTMLButtonElement>("[data-saved-view-create]")
        ?.getAttribute("aria-disabled"),
    ).toBeNull(),
  );
}

describe("Saved Views encrypted persistence", () => {
  it("encrypts one rapid save, validates its name, and survives UUID failure", async () => {
    render(<StrictMode>{menu()}</StrictMode>);
    await openReady();
    click(document.querySelector("[data-saved-view-create]"));
    setInput("x".repeat(61));
    click(button("Save view"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "under 60 characters",
    );
    expect(await stored()).toEqual([]);

    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("UUID unavailable");
    });
    setInput("Client review");
    const save = button("Save view");
    act(() => {
      save.click();
      save.click();
    });
    await waitFor(() =>
      expect(document.querySelector(".modal-card")).toBeNull(),
    );
    const views = await stored();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      name: "Client review",
      range: "30d",
      vsPrevious: true,
    });
    expect(views[0]?.id).toMatch(/^v-/u);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(physicalKey())).toContain('"alg":"AES-GCM"');
    expect(
      Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.getItem(localStorage.key(index) ?? ""),
      ).join(""),
    ).not.toContain("Client review");
    expect(document.body.textContent).toContain("Saved view Client review");
  });

  it("keeps the modal open and avoids false success when encryption is denied", async () => {
    render(menu());
    await openReady();
    click(document.querySelector("[data-saved-view-create]"));
    setInput("Quota-sensitive view");
    const denied = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });
    click(button("Save view"));
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "couldn't be encrypted",
      ),
    );
    expect(document.querySelector(".modal-card")).not.toBeNull();
    expect(document.body.textContent).not.toContain(
      "Saved view Quota-sensitive view.",
    );
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    denied.mockRestore();
  });

  it("retains a durable row and withholds deletion success on write failure", async () => {
    const existing = {
      id: "durable",
      name: "Durable review",
      range: "30d" as const,
      vsPrevious: true,
    };
    await seed([existing]);
    const before = localStorage.getItem(physicalKey());
    render(menu());
    await openReady();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Durable review"),
    );
    const denied = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });
    click(document.querySelector('[aria-label="Delete saved view Durable review"]'));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Existing durable views were left unchanged",
      ),
    );
    expect(document.body.textContent).toContain("Durable review");
    expect(document.body.textContent).not.toContain(
      "Deleted saved view Durable review",
    );
    expect(localStorage.getItem(physicalKey())).toBe(before);
    denied.mockRestore();
  });

  it("fails closed on a denied read and recovers through the visible retry", async () => {
    await seed([
      { id: "recover", name: "Recovered view", range: "7d", vsPrevious: false },
    ]);
    const originalGet = localStorage.getItem.bind(localStorage);
    const ciphertext = originalGet(physicalKey());
    const denied = vi
      .spyOn(localStorage, "getItem")
      .mockImplementation((key: string) => {
        if (key === physicalKey()) throw new DOMException("Denied", "SecurityError");
        return originalGet(key);
      });
    render(menu());
    click(document.querySelector('button[aria-haspopup="dialog"]'));
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "temporarily unavailable",
      ),
    );
    expect(document.querySelector("[data-saved-view-create]")?.getAttribute(
      "aria-disabled",
    )).toBe("true");
    expect(originalGet(physicalKey())).toBe(ciphertext);
    denied.mockRestore();
    click(button("Retry encrypted storage"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Recovered view"),
    );
  });

  it("discards corrupt ciphertext and clamps malformed, count, and byte bounds", async () => {
    localStorage.setItem(physicalKey(), "not-an-envelope");
    render(menu());
    click(document.querySelector('button[aria-haspopup="dialog"]'));
    await waitFor(() =>
      expect(document.body.textContent).toContain("unreadable and has been discarded"),
    );
    expect(localStorage.getItem(physicalKey())).toBeNull();

    const candidates = Array.from({ length: 100 }, (_, index) => ({
      id: `view-${index}`,
      name: `View ${index}`,
      range: "90d",
      vsPrevious: false,
      plaintextExtra: "must-not-survive",
    }));
    candidates[1]!.id = candidates[0]!.id;
    const sanitized = sanitizeSavedViews(candidates);
    expect(sanitized?.altered).toBe(true);
    expect(sanitized?.value).toHaveLength(20);
    expect(JSON.stringify(sanitized?.value)).not.toContain("plaintextExtra");
    expect(
      new TextEncoder().encode(JSON.stringify(sanitized?.value)).byteLength,
    ).toBeLessThanOrEqual(64 * 1024);
  });
});
