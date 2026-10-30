// @vitest-environment happy-dom

import { act, StrictMode } from "react";
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
  get: vi.fn(),
  patch: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiSendTimeAssets: {
    getExportRetentionPolicy: mocks.get,
    patchExportRetentionPolicy: mocks.patch,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { ExportRetentionSection } from "../../components/settings/ExportRetentionSection";
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.get.mockResolvedValue({
    data: {
      retention_days: 30,
      max_per_tenant: 20,
      current_storage_bytes: 1024,
      updated_at: "2026-07-15T12:00:00.000Z",
    },
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

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <StrictMode>
        <ExportRetentionSection canAdmin />
      </StrictMode>,
    ),
  );
}

function setInput(label: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!input) throw new Error(`Expected input: ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === "Save policy",
  );
  if (!button) throw new Error("Expected save button");
  return button;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

describe("ExportRetentionSection state", () => {
  it("sends only changed fields and suppresses duplicate saves", async () => {
    const pending = deferred<{
      data: {
        retention_days: number;
        max_per_tenant: number;
        current_storage_bytes: number;
      };
    }>();
    mocks.patch.mockReturnValueOnce(pending.promise);
    render();
    await waitFor(() => {
      expect(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Export retention days"]',
        )?.disabled,
      ).toBe(false);
    });
    setInput("Export retention days", "45");

    const button = saveButton();
    act(() => {
      button.click();
      button.click();
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith({ retention_days: 45 });

    await act(async () => {
      pending.resolve({
        data: {
          retention_days: 45,
          max_per_tenant: 20,
          current_storage_bytes: 1024,
        },
      });
      await pending.promise;
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Export retention policy saved",
    );
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("prepares the exact retention request and releases only after acknowledgement", async () => {
    const pending = deferred<{
      data: {
        retention_days: number;
        max_per_tenant: number;
        current_storage_bytes: number;
      };
    }>();
    mocks.patch.mockReturnValueOnce(pending.promise);
    render();
    await waitFor(() =>
      expect(saveButton().getAttribute("aria-disabled")).toBe("true"),
    );
    setInput("Export retention days", "60");

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Export retention policy",
        canSave: true,
        canDiscard: true,
      },
    ]);
    const preparing = prepareLifecycle(quitIntent);
    await act(async () => Promise.resolve());
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);

    await act(async () => {
      pending.resolve({
        data: {
          retention_days: 60,
          max_per_tenant: 20,
          current_storage_bytes: 1024,
        },
      });
      await preparing;
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("retains a thrown retention failure for lifecycle retry", async () => {
    mocks.patch.mockRejectedValueOnce(new Error("network unavailable"));
    render();
    await waitFor(() =>
      expect(saveButton().getAttribute("aria-disabled")).toBe("true"),
    );
    setInput("Export retention days", "90");

    await act(async () => prepareLifecycle(quitIntent));
    expect(document.body.textContent).toContain("network unavailable");
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().getAttribute("aria-disabled")).toBeNull();
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: true, canDiscard: true },
    ]);
  });
});
