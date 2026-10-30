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

import type { SmsBroadcast } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  visible: true,
  list: vi.fn(),
  progress: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));
vi.mock("../../hooks/usePoller", () => ({ usePoller: () => undefined }));
vi.mock("../../components/sms/sms-page-activity", () => ({
  useSMSDocumentVisible: () => mocks.visible,
}));
vi.mock("../../components/sms/broadcasts/BroadcastComposerModal", () => ({
  BroadcastComposerModal: () => null,
}));
vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: { list: vi.fn().mockResolvedValue({ data: [] }) },
}));
vi.mock("../../lib/sms-a2p-api", () => ({
  listSmsLists: vi.fn().mockResolvedValue({ data: { items: [] } }),
}));
vi.mock("../../lib/api-client", () => ({
  smsBroadcastsApi: {
    list: mocks.list,
    progress: mocks.progress,
    send: mocks.send,
    cancel: mocks.cancel,
    remove: mocks.remove,
  },
}));
vi.mock("../../components/Toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { BroadcastsPanel } from "../../components/sms/broadcasts/BroadcastsPanel";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.visible = true;
  vi.clearAllMocks();
  mocks.progress.mockResolvedValue({
    data: { status: "draft", sent: 0, failed: 0, held: 0, total: 0 },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function broadcast(
  index = 1,
  overrides: Partial<SmsBroadcast> = {},
): SmsBroadcast {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    id: `20000000-0000-4000-8000-${suffix}`,
    tenant_id: TENANT_ID,
    name: `Synthetic broadcast ${index}`,
    body: "Synthetic Route40 update",
    list_ids: [],
    tag: "synthetic",
    status: "draft",
    sent_count: 0,
    failed_count: 0,
    held_count: 0,
    segments_per_message: 1,
    created_at: `2026-08-21T12:${String(index % 60).padStart(2, "0")}:00Z`,
    updated_at: "2026-08-21T13:00:00Z",
    ...overrides,
  };
}

function page(
  items: SmsBroadcast[],
  options: { available?: boolean; nextCursor?: string } = {},
) {
  const available = options.available ?? true;
  return {
    data: {
      tenantId: TENANT_ID,
      items,
      snapshotAt: "2026-08-21T14:00:00Z",
      ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
      broadcastDispatchAvailable: available,
      ...(available
        ? {}
        : {
            broadcastDispatchUnavailableReason:
              "sms_broadcast_dispatch_release_held",
          }),
    },
  };
}

function render(node: ReactElement = <BroadcastsPanel />): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Missing ${label}`);
  return match;
}

describe("SMS Broadcasts protected truth states", () => {
  it("starts zero protected reads outside the exact admin role", async () => {
    mocks.canAdmin = false;
    render();
    await settle();
    expect(document.body.textContent).toContain(
      "no protected broadcast requests were started",
    );
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.progress).not.toHaveBeenCalled();
  });

  it("structurally holds dispatch and labels sent counters as provider accepted", async () => {
    mocks.list.mockResolvedValue(
      page([broadcast(1, { sent_count: 7 })], { available: false }),
    );
    render();
    await settle();

    expect(document.body.textContent).toContain(
      "durable provider reconciliation and budget settlement are unavailable",
    );
    expect(document.body.textContent).toContain("7 accepted");
    expect(document.body.textContent).not.toMatch(/7 delivered/iu);
    const send = button("Send now");
    expect(send.disabled).toBe(true);
    act(() => send.click());
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("loads an opaque next page only inside the same insertion window", async () => {
    const first = Array.from({ length: 50 }, (_, index) =>
      broadcast(index + 1),
    );
    mocks.list
      .mockResolvedValueOnce(page(first, { nextCursor: "v1.synthetic_cursor" }))
      .mockResolvedValueOnce(page([broadcast(51)]));
    render();
    await settle();

    expect(document.body.textContent).toContain(
      "More rows exist beyond this loaded insertion window",
    );
    expect(document.body.textContent).toContain("late commits");
    expect(document.body.textContent).not.toMatch(/verified[^.]*snapshot/iu);
    act(() => button("Load more broadcasts").click());
    await settle();
    expect(mocks.list).toHaveBeenLastCalledWith({
      cursor: "v1.synthetic_cursor",
      limit: 50,
      signal: expect.any(AbortSignal),
    });
    expect(document.body.textContent).toContain("Synthetic broadcast 51");
  });

  it("aborts a confidential list read when hidden and refreshes once visible", async () => {
    const firstRequest: { signal?: AbortSignal } = {};
    mocks.list
      .mockImplementationOnce(
        (options: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            firstRequest.signal = options.signal;
            options.signal?.addEventListener(
              "abort",
              () => resolve({ error: { message: "aborted" } }),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(page([broadcast()]));
    render();
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(1);

    mocks.visible = false;
    render();
    await settle();
    expect(firstRequest.signal?.aborted).toBe(true);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    mocks.visible = true;
    render();
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});
