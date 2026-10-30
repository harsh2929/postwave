// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
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

const defaultTheme = {
  logo_url: "",
  primary_color: "#2563eb",
  footer_text: "",
  show_postwave_badge: true,
};

const mocks = vi.hoisted(() => ({
  getTheme: vi.fn(),
  saveTheme: vi.fn(),
  createRegion: vi.fn(),
  removeRegion: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  defaultPreferenceCustomization: () => ({
    logo_url: "",
    primary_color: "#2563eb",
    footer_text: "",
    show_postwave_badge: true,
  }),
  api: {
    privacyPortal: {
      getPreferenceCustomization: mocks.getTheme,
      savePreferenceCustomization: mocks.saveTheme,
      regions: {
        create: mocks.createRegion,
        remove: mocks.removeRegion,
      },
    },
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { PreferenceCenterCustomization } from "../../components/privacy/PreferenceCenterCustomization";
import { RegionsCard } from "../../components/privacy/RegionsCard";
import {
  inspectLifecycle,
  prepareLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getTheme.mockResolvedValue({ data: defaultTheme });
  mocks.saveTheme.mockResolvedValue({ data: defaultTheme });
  mocks.createRegion.mockResolvedValue({ data: {} });
  mocks.removeRegion.mockResolvedValue({ data: {} });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function setInput(
  target: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  act(() => {
    const prototype =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

describe("privacy settings lifecycle", () => {
  it("prepares the exact preference-theme save and advances its baseline", async () => {
    const pending = deferred<{ data: typeof defaultTheme }>();
    mocks.saveTheme.mockReturnValueOnce(pending.promise);
    render(<PreferenceCenterCustomization />);
    const footer = document.querySelector("textarea");
    if (!footer) throw new Error("Expected footer text");
    await waitFor(() => expect(footer.disabled).toBe(false));
    setInput(footer, "Privacy matters");

    const preparing = prepareLifecycle(quitIntent);
    await flush();
    expect(mocks.saveTheme).toHaveBeenCalledTimes(1);
    expect(mocks.saveTheme).toHaveBeenCalledWith({
      ...defaultTheme,
      footer_text: "Privacy matters",
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);

    await act(async () => {
      pending.resolve({
        data: { ...defaultTheme, footer_text: "Privacy matters" },
      });
      await preparing;
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
    expect(button("Save").disabled).toBe(false);
    expect(button("Save").getAttribute("aria-disabled")).toBe("true");
  });

  it("retains a failed preference-theme draft for retry", async () => {
    mocks.saveTheme.mockRejectedValueOnce(new Error("privacy API offline"));
    render(<PreferenceCenterCustomization />);
    const footer = document.querySelector("textarea");
    if (!footer) throw new Error("Expected footer text");
    await waitFor(() => expect(footer.disabled).toBe(false));
    setInput(footer, "Retry me");

    await act(async () => prepareLifecycle(quitIntent));
    expect(footer.value).toBe("Retry me");
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "The preference-center theme couldn't be saved.",
      detail:
        "The server could not verify this data. The draft remains available for retry.",
    });
    expect(document.body.textContent).not.toContain("privacy API offline");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: true, canDiscard: true },
    ]);
  });

  it("keeps privacy-region creation discard-only and single-flights failures", async () => {
    const pending = deferred<{ data: Record<string, never> }>();
    mocks.createRegion.mockReturnValueOnce(pending.promise);
    render(<RegionsCard regions={[]} onChanged={vi.fn()} />);
    act(() => button("Add region").click());
    const code = document.querySelector<HTMLInputElement>(
      'input[placeholder="EU / US-CA / BR / …"]',
    );
    if (!code) throw new Error("Expected region code");
    setInput(code, "US-CA");

    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.createRegion).not.toHaveBeenCalled();
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Privacy region draft", canSave: false, canDiscard: true },
    ]);

    const add = button("Add region");
    act(() => {
      add.click();
      add.click();
    });
    expect(mocks.createRegion).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);
    await act(async () => {
      pending.reject(new Error("region API offline"));
      await pending.promise.catch(() => undefined);
    });
    await flush();
    expect(code.value).toBe("US-CA");
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "The privacy region couldn't be created.",
      detail: "No region change was confirmed; your region draft is preserved.",
    });
    expect(document.body.textContent).not.toContain("region API offline");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: false, canDiscard: true },
    ]);
  });
});
