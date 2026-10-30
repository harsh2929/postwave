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

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  canWrite: true,
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  pick: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  guard: vi.fn(() => () => undefined),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    createCollection: mocks.create,
    deleteCollection: mocks.remove,
    getCollection: mocks.get,
    listCollections: mocks.list,
    updateCollection: mocks.update,
  },
}));
vi.mock("../../lib/store", () => ({
  useCanWrite: () => mocks.canWrite,
  useMe: () => ({
    user: "99999999-9999-4999-8999-999999999999",
    tenant: "11111111-1111-4111-8111-111111111111",
  }),
}));
vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: mocks.guard,
}));
vi.mock("../../lib/file-transfer", () => ({
  acceptDroppedFiles: mocks.accept,
  pickImportFiles: mocks.pick,
}));
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { Collections } from "../../components/Collections";

const tenant = "11111111-1111-4111-8111-111111111111";
const first = {
  id: "22222222-2222-4222-8222-222222222222",
  tenant_id: tenant,
  name: "Localized content",
  collection_type: "content",
  source_type: "uploaded",
  data: [],
  row_count: 1,
  created_at: "2026-07-22T10:00:00Z",
  updated_at: "2026-07-22T10:01:00Z",
  version: 1,
};
const detail = { ...first, data: [{ locale: "ar", message: "مرحبا" }] };
const second = {
  ...first,
  id: "33333333-3333-4333-8333-333333333333",
  name: "Schedule references",
  collection_type: "schedule",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canWrite = true;
  for (const mock of [
    mocks.accept,
    mocks.create,
    mocks.get,
    mocks.list,
    mocks.pick,
    mocks.remove,
    mocks.update,
    mocks.guard,
    mocks.toastError,
    mocks.toastSuccess,
  ]) {
    mock.mockReset();
  }
  mocks.guard.mockReturnValue(() => undefined);
  mocks.accept.mockReturnValue({ ok: false, message: "not used" });
  mocks.list.mockResolvedValue({
    data: { items: [first], total: 1 },
  });
  mocks.get.mockResolvedValue({ data: detail });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

async function renderAndSettle(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Collections />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(name: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`Missing button: ${name}`);
  return match;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Reference Collections route maturity", () => {
  it("keeps viewers metadata-only, honest, and axe-clean", async () => {
    mocks.canWrite = false;
    await renderAndSettle();

    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ includeData: false, limit: 50 }),
    );
    expect(document.body.textContent).toContain("Reference API only");
    expect(document.body.textContent).toContain("deployable coupon pools");
    expect(document.body.textContent).toContain("Read only");
    expect(button("Import reference data").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      document.querySelector(
        'button[aria-label="Review and edit Localized content"]',
      ),
    ).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();

    const result = await axe.run(container ?? document.body);
    expect(result.violations).toEqual([]);
  });

  it("fetches fresh confidential detail and clears it on live permission downgrade", async () => {
    await renderAndSettle();
    await act(async () => {
      button("Review and edit Localized content").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.get).toHaveBeenCalledWith(
      first.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(document.body.textContent).toContain("مرحبا");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    mocks.canWrite = false;
    await act(async () => {
      root?.render(<Collections />);
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain("مرحبا");
  });

  it("freezes an overlapping cursor page without advancing it", async () => {
    mocks.list
      .mockResolvedValueOnce({
        data: { items: [first], total: 2, next_cursor: "cursor-two" },
      })
      .mockResolvedValue({
        data: { items: [first], total: 2, next_cursor: "cursor-three" },
      });
    await renderAndSettle();

    await act(async () => {
      button("Load more").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "Pagination stopped without advancing the cursor",
    );

    await act(async () => {
      button("Retry").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.list.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ cursor: "cursor-two" }),
    );
  });

  it("rejects a terminal page whose count says more rows remain", async () => {
    mocks.list
      .mockResolvedValueOnce({
        data: { items: [first], total: 3, next_cursor: "cursor-two" },
      })
      .mockResolvedValueOnce({ data: { items: [second], total: 3 } });
    await renderAndSettle();

    await act(async () => {
      button("Load more").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      "page count and continuation cursor disagreed",
    );
    expect(document.body.textContent).not.toContain(second.name);
  });

  it("does not clear a refresh failure or re-enable delete during append", async () => {
    mocks.list
      .mockResolvedValueOnce({
        data: { items: [first], total: 2, next_cursor: "cursor-two" },
      })
      .mockResolvedValueOnce({ error: { message: "refresh offline" } })
      .mockReturnValueOnce(new Promise(() => undefined));
    await renderAndSettle();

    await act(async () => {
      button("Refresh").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "Refresh failed: refresh offline",
    );
    expect(button("Delete Localized content").disabled).toBe(true);

    await act(async () => {
      button("Load more").click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "Refresh failed: refresh offline",
    );
    expect(button("Delete Localized content").disabled).toBe(true);
  });

  it("keeps an operator-entered name when a delayed file read finishes", async () => {
    const bytes = new TextEncoder().encode("value\nfirst\n");
    let finishRead!: (buffer: ArrayBuffer) => void;
    const read = new Promise<ArrayBuffer>((resolve) => {
      finishRead = resolve;
    });
    const file = {
      name: "automatic-name.csv",
      size: bytes.byteLength,
      arrayBuffer: () => read,
    } as unknown as File;
    mocks.pick.mockResolvedValue({ ok: true, files: [file] });
    await renderAndSettle();

    await act(async () => {
      button("Import reference data").click();
    });
    await act(async () => {
      button("Choose CSV or JSON").click();
      await Promise.resolve();
    });
    const nameField = document.querySelector<HTMLInputElement>(
      'input[placeholder="Spring content references"]',
    );
    expect(nameField).not.toBeNull();
    await act(async () => {
      setInputValue(nameField as HTMLInputElement, "Operator supplied name");
    });
    await act(async () => {
      finishRead(bytes.buffer.slice(0) as ArrayBuffer);
      await read;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nameField?.value).toBe("Operator supplied name");
    expect(document.body.textContent).toContain("Structure checked locally");
  });

  it("pauses drag-and-drop replacement while a reviewed snapshot saves", async () => {
    const bytes = new TextEncoder().encode("value\nfirst\n");
    const file = {
      name: "reviewed.csv",
      size: bytes.byteLength,
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0) as ArrayBuffer),
    } as unknown as File;
    mocks.pick.mockResolvedValue({ ok: true, files: [file] });
    let finishCreate!: (value: { data: typeof detail }) => void;
    mocks.create.mockReturnValue(
      new Promise<{ data: typeof detail }>((resolve) => {
        finishCreate = resolve;
      }),
    );
    await renderAndSettle();
    await act(async () => {
      button("Import reference data").click();
      await Promise.resolve();
    });
    await act(async () => {
      button("Choose CSV or JSON").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      button("Create reference collection").click();
      await Promise.resolve();
    });

    const dropzone = document.querySelector<HTMLElement>(
      ".collections-dropzone",
    );
    expect(dropzone?.getAttribute("aria-disabled")).toBe("true");
    expect(dropzone?.textContent).toContain("file replacement is paused");
    mocks.accept.mockClear();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: { 0: file, length: 1, item: () => file } },
    });
    await act(async () => {
      dropzone?.dispatchEvent(drop);
    });
    expect(mocks.accept).not.toHaveBeenCalled();

    await act(async () => {
      finishCreate({ data: detail });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("blocks lifecycle during delete and reconciles an interrupted downgrade", async () => {
    let aborted = false;
    mocks.remove.mockImplementation(
      (_id: string, _version: number, options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve({ error: { message: "aborted" } });
            },
            { once: true },
          );
        }),
    );
    await renderAndSettle();

    await act(async () => {
      button("Delete Localized content").click();
    });
    const confirmation = document.querySelector<HTMLInputElement>(
      '[role="alertdialog"] input[type="text"]',
    );
    expect(confirmation).not.toBeNull();
    await act(async () => {
      setInputValue(confirmation as HTMLInputElement, first.name);
    });
    await act(async () => {
      button("Delete permanently").click();
      await Promise.resolve();
    });

    expect(mocks.remove).toHaveBeenCalledTimes(1);
    const guardCalls = mocks.guard.mock.calls as unknown as Array<
      [
        {
          label: string;
          inspect: (intent: {
            kind: "route-change";
            disposition: "navigate";
            title: string;
            description: string;
            confirmLabel: string;
          }) => unknown;
        },
      ]
    >;
    const busyGuard = [...guardCalls]
      .reverse()
      .map(([guard]) => guard)
      .find((guard) => guard.label === "Permanent collection deletion");
    expect(busyGuard).toBeDefined();
    expect(
      busyGuard?.inspect({
        kind: "route-change",
        disposition: "navigate",
        title: "Leave Collections?",
        description: "The route is changing.",
        confirmLabel: "Leave",
      }),
    ).toEqual({
      level: "blocking",
      detail:
        "A permanent collection deletion is waiting for server acknowledgement.",
      canDiscard: false,
    });

    const readsBeforeDowngrade = mocks.list.mock.calls.length;
    mocks.canWrite = false;
    await act(async () => {
      root?.render(<Collections />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(aborted).toBe(true);
    expect(mocks.list.mock.calls.length).toBeGreaterThan(readsBeforeDowngrade);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
