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

import type { SuppressionRow } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  bulkDelete: vi.fn(),
  bulkAction: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  SUPPRESSION_REASONS_X1: [
    { value: "manual_unsubscribe", label: "Manual unsubscribe" },
    { value: "list_manual", label: "List manual" },
  ],
  suppressionsApi: {
    bulkDelete: mocks.bulkDelete,
    bulkAction: mocks.bulkAction,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { BulkActionsMenu } from "../../components/suppressions/BulkActionsMenu";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

const selected: SuppressionRow[] = [
  { id: "row-a", email: "a@example.com", reason: "hard_bounce" },
  { id: "row-b", email: "b@example.com", reason: "dsar_deletion" },
];

function renderMenu({
  onClear = vi.fn(),
  onAfterMutate = vi.fn(),
}: {
  onClear?: () => void;
  onAfterMutate?: () => void;
} = {}): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <BulkActionsMenu
        selected={selected}
        onClear={onClear}
        onAfterMutate={onAfterMutate}
      />,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("BulkActionsMenu", () => {
  it("force-removes only rows the server marks as forceable", async () => {
    const onClear = vi.fn();
    const onAfterMutate = vi.fn();
    mocks.bulkDelete
      .mockResolvedValueOnce({
        data: {
          deleted_count: 0,
          blocked: [
            "force-row: hard_bounce requires force=true",
            "dsar-row: dsar_deletion is permanent",
          ],
          errors: ["missing-row: not found"],
        },
      })
      .mockResolvedValueOnce({
        data: { deleted_count: 1, blocked: [], errors: [] },
      });
    renderMenu({ onClear, onAfterMutate });

    act(() => button("Remove selected").click());
    act(() => button("Review and remove").click());

    await waitFor(() => {
      expect(mocks.bulkDelete).toHaveBeenCalledWith({
        emails: ["a@example.com", "b@example.com"],
        force: false,
      });
      expect(document.body.textContent).toContain("2 blocked by policy");
      expect(document.body.textContent).toContain(
        "1 row is permanent (DSAR) and cannot be released.",
      );
      expect(document.body.textContent).toContain("missing-row: not found");
    });

    act(() => button("Override and remove 1 blocked").click());
    await waitFor(() => {
      expect(mocks.bulkDelete).toHaveBeenLastCalledWith({
        ids: ["force-row"],
        force: true,
      });
      expect(onAfterMutate).toHaveBeenCalledTimes(1);
      expect(onClear).toHaveBeenCalledTimes(1);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "1 canonical suppression rule removed",
    );
  });

  it("changes the reason for the exact selected email set", async () => {
    const onClear = vi.fn();
    const onAfterMutate = vi.fn();
    mocks.bulkAction.mockResolvedValueOnce({
      data: { updated_count: 1, errors: [] },
    });
    renderMenu({ onClear, onAfterMutate });

    act(() => button("Change reason").click());
    act(() => button("Apply reason").click());

    await waitFor(() => {
      expect(mocks.bulkAction).toHaveBeenCalledWith({
        emails: ["a@example.com", "b@example.com"],
        action: "change_reason",
        reason: "manual_unsubscribe",
      });
      expect(onAfterMutate).toHaveBeenCalledTimes(1);
      expect(onClear).toHaveBeenCalledTimes(1);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith({
      message: "1 row updated to Manual unsubscribe",
      detail: "1 selected row had no converged entry to update.",
    });
  });

  it("keeps the delete dialog open and shows an API failure", async () => {
    mocks.bulkDelete.mockResolvedValueOnce({
      error: { message: "Service unavailable" },
    });
    renderMenu();

    act(() => button("Remove selected").click());
    act(() => button("Review and remove").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain("Service unavailable");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("serializes same-tick destructive requests and exposes no button titles", async () => {
    const request = deferred<{
      data: { deleted_count: number; blocked: string[]; errors: string[] };
    }>();
    mocks.bulkDelete.mockReturnValue(request.promise);
    renderMenu();

    act(() => button("Remove selected").click());
    const confirm = button("Review and remove");
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(mocks.bulkDelete).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);

    await act(async () => {
      request.resolve({
        data: { deleted_count: 2, blocked: [], errors: [] },
      });
      await request.promise;
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "2 canonical suppression rules removed",
    );
  });
});
