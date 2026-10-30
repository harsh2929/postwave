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

const mocks = vi.hoisted(() => ({
  listExports: vi.fn(),
  createExport: vi.fn(),
  listFlags: vi.fn(),
  upsertFlag: vi.fn(),
  removeFlag: vi.fn(),
  resolveFlag: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  exportsApi: {
    list: mocks.listExports,
    create: mocks.createExport,
  },
  featureFlagsApi: {
    list: mocks.listFlags,
    upsert: mocks.upsertFlag,
    remove: mocks.removeFlag,
    resolve: mocks.resolveFlag,
  },
}));

vi.mock("../../lib/store", () => ({ useCanAdmin: () => true }));
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { DataExportsSection } from "../../components/settings/DataExportsSection";
import { FeatureFlagsSection } from "../../components/settings/FeatureFlagsSection";
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
  mocks.listExports.mockResolvedValue({ data: { exports: [] } });
  mocks.createExport.mockResolvedValue({ data: { id: "export-1" } });
  mocks.listFlags.mockResolvedValue({ data: { flags: [] } });
  mocks.upsertFlag.mockResolvedValue({ data: { key: "new_flag" } });
  mocks.removeFlag.mockResolvedValue({ data: {} });
  mocks.resolveFlag.mockResolvedValue({
    data: { key: "new_flag", value: "on", source: "tenant" },
  });
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

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

function setInput(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
} {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
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

describe("settings action-draft lifecycle", () => {
  it("never auto-queues an export and retains a rejected selection", async () => {
    const pending = deferred<{ data: { id: string } }>();
    mocks.createExport.mockReturnValueOnce(pending.promise);
    render(<DataExportsSection />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("No exports yet"),
    );
    act(() => button("+ New export").click());
    const firstInclude = document.querySelector<HTMLInputElement>(
      '.radio-row input[type="checkbox"]',
    );
    if (!firstInclude) throw new Error("Expected export include option");
    act(() => firstInclude.click());

    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.createExport).not.toHaveBeenCalled();
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Data export selection", canSave: false, canDiscard: true },
    ]);

    const queue = button("Queue export");
    act(() => {
      queue.click();
      queue.click();
    });
    expect(mocks.createExport).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);
    await act(async () => {
      pending.reject(new Error("export API offline"));
      await pending.promise.catch(() => undefined);
    });
    await flush();
    expect(firstInclude.checked).toBe(false);
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Couldn't queue export",
      detail: "export API offline",
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: false, canDiscard: true },
    ]);
  });

  it("never auto-upserts a flag and keeps a failed override retryable", async () => {
    const pending = deferred<{ data: { key: string } }>();
    mocks.upsertFlag.mockReturnValueOnce(pending.promise);
    render(<FeatureFlagsSection />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("No flags defined"),
    );
    act(() => button("+ Set flag").click());
    const key = document.querySelector<HTMLInputElement>("#ff-key");
    const value = document.querySelector<HTMLInputElement>("#ff-value");
    if (!key || !value) throw new Error("Expected feature-flag fields");
    setInput(key, "new_flag");
    setInput(value, "on");

    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.upsertFlag).not.toHaveBeenCalled();
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Feature flag draft", canSave: false, canDiscard: true },
    ]);

    const save = button("Save flag");
    act(() => {
      save.click();
      save.click();
    });
    expect(mocks.upsertFlag).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);
    await act(async () => {
      pending.reject(new Error("flags API offline"));
      await pending.promise.catch(() => undefined);
    });
    await flush();
    expect(key.value).toBe("new_flag");
    expect(value.value).toBe("on");
    expect(document.body.textContent).toContain("flags API offline");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: false, canDiscard: true },
    ]);
  });
});
