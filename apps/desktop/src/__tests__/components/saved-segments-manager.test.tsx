// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
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

import type {
  SavedSegment,
  SavedSegmentPatch,
  SegmentFolder,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
  listFolders: vi.fn(),
  listSegments: vi.fn(),
  patchFolder: vi.fn(),
  patchSegment: vi.fn(),
  preview: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  createSegmentFolder: mocks.createFolder,
  deleteSegmentFolder: mocks.deleteFolder,
  listSavedSegments: mocks.listSegments,
  listSegmentFolders: mocks.listFolders,
  patchSavedSegment: mocks.patchSegment,
  patchSegmentFolder: mocks.patchFolder,
  previewSavedSegmentDetail: mocks.preview,
}));

vi.mock("../../lib/format-date", () => ({
  fmtRelative: () => "recently",
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: ({
    busy,
    children,
    confirmLabel = "Confirm",
    description,
    onClose,
    onConfirm,
    open,
    title,
  }: {
    busy?: boolean;
    children?: ReactNode;
    confirmLabel?: string;
    description?: string;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        <p>{description}</p>
        {children}
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" onClick={() => void onConfirm()} disabled={busy}>
          {confirmLabel}
        </button>
      </section>
    ) : null,
}));

import { SavedSegmentsManager } from "../../components/segments/SavedSegmentsManager";
import { UNFILED } from "../../components/segments/useSavedSegmentsController";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function folder(
  id: string,
  name: string,
  overrides: Partial<SegmentFolder> = {},
): SegmentFolder {
  return {
    id,
    tenant_id: "tenant/one",
    name,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function segment(overrides: Partial<SavedSegment> = {}): SavedSegment {
  return {
    id: "segment/a",
    tenant_id: "tenant/one",
    name: "Pinned A",
    description: "First audience",
    predicate_json: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    is_pinned: true,
    pin_order: 0,
    visibility_scope: "personal",
    last_count: 12,
    last_evaluated_at: "2026-02-28T00:00:00Z",
    ...overrides,
  };
}

const baseFolders = [folder("folder/lifecycle", "Lifecycle")];
const baseSegments = [
  segment(),
  segment({
    id: "segment/b",
    name: "Pinned B",
    pin_order: 1,
    updated_at: "2026-02-01T00:00:00Z",
  }),
  segment({
    id: "segment/c",
    name: "Filed C",
    is_pinned: false,
    pin_order: undefined,
    folder_id: "folder/lifecycle",
  }),
];

function patchedSegment(id: string, patch: SavedSegmentPatch): SavedSegment {
  const current =
    baseSegments.find((candidate) => candidate.id === id) ?? segment({ id });
  return {
    ...current,
    ...patch,
    folder_id:
      patch.folder_id === ""
        ? undefined
        : (patch.folder_id ?? current.folder_id),
  };
}

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
  vi.resetAllMocks();
  mocks.listSegments.mockResolvedValue({ data: { items: baseSegments } });
  mocks.listFolders.mockResolvedValue({ data: { items: baseFolders } });
  mocks.patchSegment.mockImplementation(
    async (id: string, patch: SavedSegmentPatch) => ({
      data: patchedSegment(id, patch),
    }),
  );
  mocks.preview.mockImplementation(async (id: string) => ({
    data: {
      id,
      count: 99,
      workspace_total: 100,
      workspace_percentage: 99,
      generated_at: "2026-07-18T12:00:00.000Z",
    },
  }));
  mocks.createFolder.mockResolvedValue({
    data: folder("folder/new", "New folder"),
  });
  mocks.patchFolder.mockImplementation(async (id: string, name: string) => ({
    data: folder(id, name),
  }));
  mocks.deleteFolder.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderManager(canMutate: boolean): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<SavedSegmentsManager canMutate={canMutate} />));
}

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = container?.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(found).not.toBeNull();
  return found!;
}

function buttonByText(label: string, rootNode: ParentNode = container!) {
  const found = Array.from(rootNode.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}

function setNativeValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
}

function change(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  act(() => {
    setNativeValue(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

describe("SavedSegmentsManager read and authorization boundaries", () => {
  it("loads grouped bookmarks, fails writes closed for viewers, and permits read-scope recounts", async () => {
    renderManager(false);
    await flushEffects();

    expect(mocks.listSegments).toHaveBeenCalledTimes(1);
    expect(mocks.listFolders).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("Pinned A");
    expect(container?.textContent).toContain("Lifecycle");
    expect(buttonByLabel("Unpin segment").disabled).toBe(false);
    expect(buttonByLabel("Unpin segment").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      container?.querySelector<HTMLSelectElement>(
        'select[aria-label="Sharing for Pinned A"]',
      )?.disabled,
    ).toBe(false);
    expect(
      container
        ?.querySelector<HTMLSelectElement>(
          'select[aria-label="Sharing for Pinned A"]',
        )
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    expect(buttonByText("Add folder").disabled).toBe(false);
    expect(buttonByText("Add folder").getAttribute("aria-disabled")).toBe(
      "true",
    );

    const count = buttonByLabel("Member count for Pinned A: 12. Refresh.");
    expect(count.disabled).toBe(false);
    act(() => {
      count.click();
      count.click();
    });
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    await flushEffects();
    expect(
      container?.querySelector(
        'button[aria-label="Member count for Pinned A: 99. Refresh."]',
      ),
    ).not.toBeNull();
    expect(mocks.patchSegment).not.toHaveBeenCalled();
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("surfaces an auxiliary folder failure and disables only folder writes", async () => {
    mocks.listFolders.mockResolvedValue({
      error: { code: "unavailable", message: "folder service down" },
    });
    renderManager(true);
    await flushEffects();

    expect(container?.textContent).toContain(
      "Folder organization is unavailable: The server could not verify this data.",
    );
    expect(container?.textContent).not.toContain("folder service down");
    expect(buttonByLabel("Unpin segment").disabled).toBe(false);
    expect(
      container?.querySelector<HTMLSelectElement>(
        'select[aria-label="Folder for Pinned A"]',
      )?.disabled,
    ).toBe(false);
    expect(
      container
        ?.querySelector<HTMLSelectElement>(
          'select[aria-label="Folder for Pinned A"]',
        )
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    expect(buttonByText("Add folder").disabled).toBe(false);
    expect(buttonByText("Add folder").getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("retains the last verified bookmarks when a refresh fails", async () => {
    renderManager(true);
    await flushEffects();
    expect(container?.textContent).toContain("Pinned A");
    mocks.listSegments.mockResolvedValueOnce({
      error: { kind: "http", status: 503, message: "private upstream detail" },
    });

    act(() => buttonByText("Refresh").click());
    await flushEffects();

    expect(container?.textContent).toContain("Pinned A");
    expect(container?.textContent).toContain(
      "Couldn't load saved segments: The service could not complete the request.",
    );
    expect(container?.textContent).not.toContain("private upstream detail");
    expect(container?.textContent).not.toContain("No saved segments yet");
  });

  it("never fans out count requests merely because the manager opened", async () => {
    const uncounted = Array.from({ length: 10 }, (_, index) =>
      segment({
        id: `segment/${index}`,
        name: `Segment ${index}`,
        is_pinned: false,
        pin_order: undefined,
        last_count: undefined,
        last_evaluated_at: undefined,
      }),
    );
    mocks.listSegments.mockResolvedValue({ data: { items: uncounted } });
    renderManager(false);
    await flushEffects();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("rejects a malformed explicit member count without corrupting the badge", async () => {
    mocks.preview.mockResolvedValue({
      data: {
        id: "segment/a",
        count: -1,
        workspace_total: 100,
        workspace_percentage: 0,
        generated_at: "2026-07-18T12:00:00.000Z",
      },
    });
    renderManager(false);
    await flushEffects();
    act(() => buttonByLabel("Member count for Pinned A: 12. Refresh.").click());
    await flushEffects();
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Couldn't refresh count",
      detail: "The server returned an invalid aggregate count.",
    });
    expect(
      container?.querySelector(
        'button[aria-label="Member count for Pinned A: 12. Refresh."]',
      ),
    ).not.toBeNull();
  });
});

describe("SavedSegmentsManager mutation serialization", () => {
  it("serializes a same-tick pin mutation and applies only the server row", async () => {
    const request = deferred<{ data: SavedSegment }>();
    mocks.patchSegment.mockReturnValue(request.promise);
    renderManager(true);
    await flushEffects();
    const pin = buttonByLabel("Unpin segment");
    act(() => {
      pin.click();
      pin.click();
    });
    expect(mocks.patchSegment).toHaveBeenCalledTimes(1);
    expect(mocks.patchSegment).toHaveBeenCalledWith("segment/a", {
      is_pinned: false,
    });
    expect(pin.disabled).toBe(true);

    await act(async () => {
      request.resolve({
        data: segment({ is_pinned: false, pin_order: undefined }),
      });
      await request.promise;
    });
    expect(buttonByLabel("Pin segment").disabled).toBe(false);
  });

  it("persists exact sharing and unfile patches and ignores forged select values", async () => {
    renderManager(true);
    await flushEffects();
    const sharing = container?.querySelector<HTMLSelectElement>(
      'select[aria-label="Sharing for Filed C"]',
    );
    const folderSelect = container?.querySelector<HTMLSelectElement>(
      'select[aria-label="Folder for Filed C"]',
    );
    change(sharing!, "workspace");
    await flushEffects();
    expect(mocks.patchSegment).toHaveBeenNthCalledWith(1, "segment/c", {
      visibility_scope: "workspace",
    });

    const refreshedFolder = container?.querySelector<HTMLSelectElement>(
      'select[aria-label="Folder for Filed C"]',
    );
    change(refreshedFolder!, UNFILED);
    await flushEffects();
    expect(mocks.patchSegment).toHaveBeenNthCalledWith(2, "segment/c", {
      folder_id: "",
    });

    const refreshedSharing = container?.querySelector<HTMLSelectElement>(
      'select[aria-label="Sharing for Filed C"]',
    );
    const unfiledSelect = container?.querySelector<HTMLSelectElement>(
      'select[aria-label="Folder for Filed C"]',
    );
    change(refreshedSharing!, "owner");
    change(unfiledSelect!, "folder/foreign");
    await flushEffects();
    expect(mocks.patchSegment).toHaveBeenCalledTimes(2);
    expect(folderSelect).not.toBeNull();
  });

  it("offers drag handles and serializes exact dense ordering through keyboard buttons", async () => {
    renderManager(true);
    await flushEffects();
    expect(
      buttonByLabel("Drag Pinned A to reorder").getAttribute("draggable"),
    ).toBe("true");
    const moveUp = buttonByLabel("Move Pinned B up");
    act(() => {
      moveUp.click();
      moveUp.click();
    });
    await flushEffects();

    expect(mocks.patchSegment).toHaveBeenCalledTimes(2);
    expect(mocks.patchSegment).toHaveBeenNthCalledWith(1, "segment/b", {
      pin_order: 0,
    });
    expect(mocks.patchSegment).toHaveBeenNthCalledWith(2, "segment/a", {
      pin_order: 1,
    });
    const rows = Array.from(
      container?.querySelectorAll<HTMLDivElement>(".list-row") ?? [],
    );
    expect(rows[0]?.textContent).toContain("Pinned B");
    expect(rows[1]?.textContent).toContain("Pinned A");
  });

  it("resynchronizes after a partial reorder failure", async () => {
    mocks.patchSegment
      .mockResolvedValueOnce({
        data: segment({ id: "segment/b", pin_order: 0 }),
      })
      .mockResolvedValueOnce({
        error: { code: "conflict", message: "stale order" },
      });
    renderManager(true);
    await flushEffects();
    act(() => buttonByLabel("Move Pinned B up").click());
    await flushEffects();

    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Couldn't save the new order",
    });
    expect(mocks.listSegments).toHaveBeenCalledTimes(2);
    expect(mocks.listFolders).toHaveBeenCalledTimes(2);
  });

  it("creates, renames, and deletes folders with trimmed, serialized writes", async () => {
    const createRequest = deferred<{ data: SegmentFolder }>();
    mocks.createFolder.mockReturnValue(createRequest.promise);
    renderManager(true);
    await flushEffects();
    const newName = container?.querySelector<HTMLInputElement>(
      'input[aria-label="New folder name"]',
    );
    const form = newName?.closest("form");
    change(newName!, "  New folder  ");
    act(() => {
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(mocks.createFolder).toHaveBeenCalledTimes(1);
    expect(mocks.createFolder).toHaveBeenCalledWith("New folder");
    await act(async () => {
      createRequest.resolve({ data: folder("folder/new", "New folder") });
      await createRequest.promise;
    });

    act(() => buttonByLabel("Rename folder Lifecycle").click());
    const renameDialog = container?.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Rename folder"]',
    );
    const renameInput = renameDialog?.querySelector<HTMLInputElement>("input");
    change(renameInput!, "  Lifecycle VIP  ");
    act(() => buttonByText("Rename", renameDialog!).click());
    await flushEffects();
    expect(mocks.patchFolder).toHaveBeenCalledWith(
      "folder/lifecycle",
      "Lifecycle VIP",
    );

    act(() => buttonByLabel("Delete folder Lifecycle VIP").click());
    const deleteDialog = container?.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Delete folder"]',
    );
    act(() => buttonByText("Delete folder", deleteDialog!).click());
    await flushEffects();
    expect(mocks.deleteFolder).toHaveBeenCalledWith("folder/lifecycle");
    expect(
      container?.querySelector<HTMLSelectElement>(
        'select[aria-label="Folder for Filed C"]',
      )?.value,
    ).toBe(UNFILED);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Folder deleted — its segments were unfiled",
    );
  });

  it("suppresses a late write response and toast after unmount", async () => {
    const request = deferred<{
      error: { code: string; message: string };
    }>();
    mocks.patchSegment.mockReturnValue(request.promise);
    renderManager(true);
    await flushEffects();
    act(() => buttonByLabel("Unpin segment").click());
    act(() => root?.unmount());
    root = null;
    await act(async () => {
      request.resolve({ error: { code: "failed", message: "late" } });
      await request.promise;
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

describe("SavedSegmentsManager quality boundary", () => {
  it("uses controller/view boundaries and removes the legacy function ratchet", () => {
    const source = readFileSync(
      "src/components/segments/SavedSegmentsManager.tsx",
      "utf8",
    );
    const budgets = readFileSync(
      "scripts/function-quality-budgets.json",
      "utf8",
    );
    expect(source).toContain("useSavedSegmentsController");
    expect(source).toContain("SavedSegmentsManagerView");
    expect(budgets).not.toContain(
      '"src/components/segments/SavedSegmentsManager.tsx"',
    );
  });
});
