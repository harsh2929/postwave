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

import { mergeLayoutOrder } from "../../components/dashboard/dashboard-sections";

const mocks = vi.hoisted(() => ({
  getLayout: vi.fn(),
  putLayout: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getDashboardLayout: mocks.getLayout,
    putDashboardLayout: mocks.putLayout,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

import {
  type DashboardLayoutController,
  normalizeDashboardLayout,
  useDashboardLayout,
  validateDashboardLayout,
} from "../../pages/dashboard/useDashboardLayout";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const BASE_ORDER = mergeLayoutOrder(null, {});
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: DashboardLayoutController | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLayout.mockResolvedValue({
    data: {
      userId: "user-1",
      tenantId: "tenant-1",
      order: BASE_ORDER,
      updatedAt: "2026-07-16T08:00:00.000Z",
    },
  });
  mocks.putLayout.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Probe({ workspace }: { workspace: string }): ReactElement {
  const controller = useDashboardLayout(workspace);
  latest = controller;
  return (
    <>
      <div data-testid="layout">{controller.layout?.join(",") ?? "null"}</div>
      <div data-testid="save-status">{controller.saveStatus}</div>
      <div data-testid="save-message">{controller.saveMessage ?? "null"}</div>
    </>
  );
}

function renderController(workspace = "tenant-1"): {
  rerender: (nextWorkspace: string) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe workspace={workspace} />));
  return {
    rerender(nextWorkspace) {
      act(() => root?.render(<Probe workspace={nextWorkspace} />));
    },
  };
}

function layoutText(): string | null {
  return document.querySelector('[data-testid="layout"]')?.textContent ?? null;
}

function saveStatusText(): string | null {
  return (
    document.querySelector('[data-testid="save-status"]')?.textContent ?? null
  );
}

function saveMessageText(): string | null {
  return (
    document.querySelector('[data-testid="save-message"]')?.textContent ?? null
  );
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

async function renderLoaded(): Promise<void> {
  renderController();
  await waitFor(() => expect(layoutText()).toBe(BASE_ORDER.join(",")));
}

describe("dashboard layout controller", () => {
  it("loads the persisted order and validates the server write contract", async () => {
    await renderLoaded();

    expect(mocks.getLayout).toHaveBeenCalledTimes(1);
    expect(saveStatusText()).toBe("idle");
    expect(saveMessageText()).toBe("null");
    expect(validateDashboardLayout(BASE_ORDER)).toBeNull();
    expect(validateDashboardLayout([])).toContain("1–16");
    expect(
      validateDashboardLayout(Array.from({ length: 17 }, (_, i) => `k${i}`)),
    ).toContain("1–16");
    expect(validateDashboardLayout(["x".repeat(65)])).toContain("invalid");
    expect(normalizeDashboardLayout(BASE_ORDER)).toEqual(BASE_ORDER);
    expect(normalizeDashboardLayout("not-an-array")).toBeNull();
    expect(normalizeDashboardLayout(["subs", "subs"])).toBeNull();
    expect(normalizeDashboardLayout([1, 2, 3])).toBeNull();
    expect(
      normalizeDashboardLayout(Array.from({ length: 17 }, (_, i) => `k${i}`)),
    ).toBeNull();
  });

  it("rejects malformed saved layouts and keeps the safe default", async () => {
    mocks.getLayout.mockResolvedValueOnce({ data: { order: { bad: true } } });
    renderController();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));

    expect(layoutText()).toBe("null");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't load your saved Dashboard layout. The default layout is shown.",
    );
  });

  it("contains thrown layout loads without leaking transport detail", async () => {
    mocks.getLayout.mockRejectedValueOnce(new Error("token=private-layout"));
    renderController();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));

    expect(layoutText()).toBe("null");
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "private-layout",
    );
  });

  it("publishes idle, saving, and confirmed saved states without a reset timer", async () => {
    const pendingSave = deferred<{ data: { ok: boolean } }>();
    mocks.putLayout.mockReturnValueOnce(pendingSave.promise);
    await renderLoaded();
    const expected = mergeLayoutOrder(BASE_ORDER, {
      stats: ["bounces", "clicks", "opens", "subs"],
    });

    act(() =>
      latest?.persist({ stats: ["bounces", "clicks", "opens", "subs"] }),
    );
    expect(layoutText()).toBe(expected.join(","));
    expect(saveStatusText()).toBe("saving");
    expect(saveMessageText()).toBe("Saving layout…");

    await act(async () => {
      pendingSave.resolve({ data: { ok: true } });
      await pendingSave.promise;
    });
    await waitFor(() => expect(saveStatusText()).toBe("saved"));
    expect(saveMessageText()).toBe("Layout saved.");

    await act(async () => Promise.resolve());
    expect(saveStatusText()).toBe("saved");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("does not let a late initial load overwrite an operator reorder", async () => {
    const pendingLoad = deferred<{
      data: {
        userId: string;
        tenantId: string;
        order: string[];
        updatedAt: string;
      };
    }>();
    mocks.getLayout.mockReturnValue(pendingLoad.promise);
    renderController();
    const expected = mergeLayoutOrder(null, {
      stats: ["bounces", "clicks", "opens", "subs"],
    });
    act(() =>
      latest?.persist({ stats: ["bounces", "clicks", "opens", "subs"] }),
    );
    await waitFor(() => expect(mocks.putLayout).toHaveBeenCalledTimes(1));

    await act(async () => {
      pendingLoad.resolve({
        data: {
          userId: "user-1",
          tenantId: "tenant-1",
          order: ["stale"],
          updatedAt: "2026-07-16T08:00:00.000Z",
        },
      });
      await pendingLoad.promise;
    });
    expect(layoutText()).toBe(expected.join(","));
  });

  it("serializes saves and rolls a failed latest order back to the confirmed one", async () => {
    const firstSave = deferred<{ data: { ok: boolean } }>();
    const secondSave = deferred<{
      error: {
        kind: "http";
        status: number;
        code: string;
        message: string;
      };
    }>();
    mocks.putLayout
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    await renderLoaded();
    const firstOrder = mergeLayoutOrder(BASE_ORDER, {
      sections: ["clv", "forecast"],
    });
    const secondOrder = mergeLayoutOrder(firstOrder, {
      stats: ["bounces", "subs"],
    });
    act(() => latest?.persist({ sections: ["clv", "forecast"] }));
    act(() => latest?.persist({ stats: ["bounces", "subs"] }));

    expect(mocks.putLayout).toHaveBeenCalledTimes(1);
    expect(mocks.putLayout).toHaveBeenNthCalledWith(1, { order: firstOrder });
    expect(layoutText()).toBe(secondOrder.join(","));
    expect(saveStatusText()).toBe("saving");
    await act(async () => {
      firstSave.resolve({ data: { ok: true } });
      await firstSave.promise;
    });
    await waitFor(() => expect(mocks.putLayout).toHaveBeenCalledTimes(2));
    expect(mocks.putLayout).toHaveBeenNthCalledWith(2, { order: secondOrder });
    expect(saveStatusText()).toBe("saving");
    await act(async () => {
      secondSave.resolve({
        error: {
          kind: "http",
          status: 409,
          code: "layout_conflict",
          message: "conflict",
        },
      });
      await secondSave.promise;
    });
    await waitFor(() => expect(layoutText()).toBe(firstOrder.join(",")));
    expect(saveStatusText()).toBe("failed");
    expect(saveMessageText()).toBe(
      "Layout wasn’t saved. Showing the last confirmed layout.",
    );
    expect(saveMessageText()).not.toContain("conflict");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Layout wasn’t saved because the latest order could not be confirmed. Try again.",
    );
  });

  it("coalesces rapid queued moves and reports saved only after the latest order is confirmed", async () => {
    const firstSave = deferred<{ data: { ok: boolean } }>();
    const latestSave = deferred<{ data: { ok: boolean } }>();
    mocks.putLayout
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(latestSave.promise);
    await renderLoaded();

    const firstOrder = mergeLayoutOrder(BASE_ORDER, {
      sections: ["clv", "forecast"],
    });
    const supersededOrder = mergeLayoutOrder(firstOrder, {
      stats: ["bounces", "subs"],
    });
    const latestOrder = mergeLayoutOrder(supersededOrder, {
      sections: ["goals", "clv", "forecast"],
    });

    act(() => latest?.persist({ sections: ["clv", "forecast"] }));
    act(() => latest?.persist({ stats: ["bounces", "subs"] }));
    act(() => latest?.persist({ sections: ["goals", "clv", "forecast"] }));

    expect(layoutText()).toBe(latestOrder.join(","));
    expect(saveStatusText()).toBe("saving");
    expect(mocks.putLayout).toHaveBeenCalledTimes(1);
    expect(mocks.putLayout).toHaveBeenNthCalledWith(1, { order: firstOrder });

    await act(async () => {
      firstSave.resolve({ data: { ok: true } });
      await firstSave.promise;
    });
    await waitFor(() => expect(mocks.putLayout).toHaveBeenCalledTimes(2));
    expect(mocks.putLayout).toHaveBeenNthCalledWith(2, { order: latestOrder });
    expect(mocks.putLayout).not.toHaveBeenCalledWith({
      order: supersededOrder,
    });
    expect(saveStatusText()).toBe("saving");

    await act(async () => {
      latestSave.resolve({ data: { ok: true } });
      await latestSave.promise;
    });
    await waitFor(() => expect(saveStatusText()).toBe("saved"));
    expect(layoutText()).toBe(latestOrder.join(","));
    expect(saveMessageText()).toBe("Layout saved.");
  });

  it("keeps saving when a failed request is superseded by a queued order", async () => {
    const firstSave = deferred<{
      error: { kind: "http"; status: number; message: string };
    }>();
    const latestSave = deferred<{ data: { ok: boolean } }>();
    mocks.putLayout
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(latestSave.promise);
    await renderLoaded();
    const firstOrder = mergeLayoutOrder(BASE_ORDER, {
      sections: ["clv", "forecast"],
    });
    const latestOrder = mergeLayoutOrder(firstOrder, {
      stats: ["bounces", "subs"],
    });

    act(() => latest?.persist({ sections: ["clv", "forecast"] }));
    act(() => latest?.persist({ stats: ["bounces", "subs"] }));
    await act(async () => {
      firstSave.resolve({
        error: { kind: "http", status: 503, message: "temporary failure" },
      });
      await firstSave.promise;
    });
    await waitFor(() => expect(mocks.putLayout).toHaveBeenCalledTimes(2));

    expect(mocks.putLayout).toHaveBeenNthCalledWith(2, { order: latestOrder });
    expect(layoutText()).toBe(latestOrder.join(","));
    expect(saveStatusText()).toBe("saving");
    expect(saveMessageText()).toBe("Saving layout…");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Layout wasn’t saved because the latest order could not be confirmed. Try again.",
    );

    await act(async () => {
      latestSave.resolve({ data: { ok: true } });
      await latestSave.promise;
    });
    await waitFor(() => expect(saveStatusText()).toBe("saved"));
    expect(layoutText()).toBe(latestOrder.join(","));
  });

  it("turns a thrown save request into safe failed feedback and rollback", async () => {
    mocks.putLayout.mockRejectedValueOnce(new Error("secret transport detail"));
    await renderLoaded();
    act(() =>
      latest?.persist({ stats: ["bounces", "clicks", "opens", "subs"] }),
    );

    await waitFor(() => expect(saveStatusText()).toBe("failed"));
    expect(layoutText()).toBe(BASE_ORDER.join(","));
    expect(saveMessageText()).toBe(
      "Layout wasn’t saved. Showing the last confirmed layout.",
    );
    expect(saveMessageText()).not.toContain("secret transport detail");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Layout wasn’t saved because the request could not be completed. Try again.",
    );
  });

  it("invalidates old workspace loads and suppresses post-unmount errors", async () => {
    const oldLoad = deferred<{
      error: { kind: "http"; status: number; message: string };
    }>();
    mocks.getLayout
      .mockReset()
      .mockReturnValueOnce(oldLoad.promise)
      .mockResolvedValueOnce({
        data: {
          userId: "user-2",
          tenantId: "tenant-2",
          order: BASE_ORDER,
          updatedAt: "2026-07-16T08:00:00.000Z",
        },
      });
    const view = renderController("tenant-1");
    view.rerender("tenant-2");
    await waitFor(() => expect(layoutText()).toBe(BASE_ORDER.join(",")));
    act(() => root?.unmount());
    root = null;

    await act(async () => {
      oldLoad.resolve({
        error: { kind: "http", status: 500, message: "stale failure" },
      });
      await oldLoad.promise;
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("isolates in-flight saves across workspace switches", async () => {
    const oldSave = deferred<{
      error: { kind: "http"; status: number; message: string };
    }>();
    const newSave = deferred<{ data: { ok: boolean } }>();
    const tenantTwoOrder = mergeLayoutOrder(null, {
      sections: ["clv", "goals", "forecast"],
    });
    mocks.getLayout
      .mockReset()
      .mockResolvedValueOnce({
        data: {
          userId: "user-1",
          tenantId: "tenant-1",
          order: BASE_ORDER,
          updatedAt: "2026-07-16T08:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        data: {
          userId: "user-2",
          tenantId: "tenant-2",
          order: tenantTwoOrder,
          updatedAt: "2026-07-16T08:05:00.000Z",
        },
      });
    mocks.putLayout
      .mockReset()
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newSave.promise);
    const view = renderController("tenant-1");
    await waitFor(() => expect(layoutText()).toBe(BASE_ORDER.join(",")));

    const oldTarget = mergeLayoutOrder(BASE_ORDER, {
      stats: ["bounces", "clicks", "opens", "subs"],
    });
    act(() =>
      latest?.persist({ stats: ["bounces", "clicks", "opens", "subs"] }),
    );
    await waitFor(() => expect(mocks.putLayout).toHaveBeenCalledTimes(1));
    expect(mocks.putLayout).toHaveBeenNthCalledWith(1, { order: oldTarget });

    view.rerender("tenant-2");
    await waitFor(() => expect(layoutText()).toBe(tenantTwoOrder.join(",")));
    expect(saveStatusText()).toBe("idle");
    expect(saveMessageText()).toBe("null");
    const newTarget = mergeLayoutOrder(tenantTwoOrder, {
      sections: ["goals", "clv", "forecast"],
    });
    act(() => latest?.persist({ sections: ["goals", "clv", "forecast"] }));
    await waitFor(() => expect(mocks.putLayout).toHaveBeenCalledTimes(2));
    expect(mocks.putLayout).toHaveBeenNthCalledWith(2, { order: newTarget });
    expect(saveStatusText()).toBe("saving");

    await act(async () => {
      oldSave.resolve({
        error: { kind: "http", status: 409, message: "old workspace conflict" },
      });
      await oldSave.promise;
    });
    expect(layoutText()).toBe(newTarget.join(","));
    expect(saveStatusText()).toBe("saving");
    expect(saveMessageText()).toBe("Saving layout…");
    expect(mocks.toastError).not.toHaveBeenCalled();

    await act(async () => {
      newSave.resolve({ data: { ok: true } });
      await newSave.promise;
    });
    expect(layoutText()).toBe(newTarget.join(","));
    await waitFor(() => expect(saveStatusText()).toBe("saved"));
    expect(saveMessageText()).toBe("Layout saved.");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("suppresses failed save feedback after unmount", async () => {
    const pendingSave = deferred<{
      error: { kind: "http"; status: number; message: string };
    }>();
    mocks.putLayout.mockReturnValueOnce(pendingSave.promise);
    await renderLoaded();
    act(() =>
      latest?.persist({ stats: ["bounces", "clicks", "opens", "subs"] }),
    );
    expect(saveStatusText()).toBe("saving");

    act(() => root?.unmount());
    root = null;
    await act(async () => {
      pendingSave.resolve({
        error: { kind: "http", status: 500, message: "after unmount" },
      });
      await pendingSave.promise;
    });

    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="save-status"]')).toBeNull();
  });
});
