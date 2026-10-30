// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueueTray } from "@/components/queue-tray";
import type { OfflineMutation } from "@/lib/offline-store";
import type { OutboxSnapshot } from "@/lib/outbox";

const mocks = vi.hoisted(() => {
  const item: OfflineMutation = {
    id: "outbox_1",
    method: "PATCH",
    path: "/api/v1/forms/form_1",
    body: { name: "Updated form" },
    idempotencyKey: "idem_1",
    queuedAt: "2026-06-27T00:00:00.000Z",
    attempts: 1,
    status: "pending",
    resource: "form:form_1",
  };
  const outbox: OutboxSnapshot = {
    all: [item],
    pending: [item],
    replaying: [],
    failed: [],
    conflicts: [],
    deadLetter: [],
    pendingCount: 1,
    attentionCount: 0,
  };

  return {
    outbox,
    discardOutboxItem: vi.fn(),
    reissueAsOverwrite: vi.fn(),
    retryOutboxItem: vi.fn(),
    flushQueuedMutations: vi.fn(async () => ({
      replayed: 0,
      failed: 0,
      conflicts: 0,
      dead: 0,
    })),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
    toastSuccess: vi.fn(),
  };
});

vi.mock("@/lib/outbox", () => ({
  discardOutboxItem: mocks.discardOutboxItem,
  reissueAsOverwrite: mocks.reissueAsOverwrite,
  retryOutboxItem: mocks.retryOutboxItem,
  useOutbox: () => mocks.outbox,
}));

vi.mock("@/lib/use-online", () => ({
  useOnline: () => "online",
}));

vi.mock("@/lib/api", () => ({
  flushQueuedMutations: mocks.flushQueuedMutations,
}));

vi.mock("sonner", () => ({
  toast: {
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
    warning: vi.fn(),
    error: mocks.toastError,
  },
}));

beforeEach(() => {
  const item = mocks.outbox.all[0]!;
  item.status = "pending";
  item.conflictStatus = undefined;
  mocks.outbox.pending = [item];
  mocks.outbox.replaying = [];
  mocks.outbox.failed = [];
  mocks.outbox.conflicts = [];
  mocks.outbox.deadLetter = [];
  mocks.outbox.pendingCount = 1;
  mocks.outbox.attentionCount = 0;
  mocks.flushQueuedMutations.mockReset();
  mocks.flushQueuedMutations.mockResolvedValue({
    replayed: 0,
    failed: 0,
    conflicts: 0,
    dead: 0,
  });
  mocks.discardOutboxItem.mockClear();
  mocks.toastInfo.mockClear();
  mocks.toastSuccess.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(flush);
    }
  }
  throw lastError;
}

function findButton(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (el): el is HTMLButtonElement =>
      el instanceof HTMLButtonElement &&
      (el.getAttribute("aria-label") === name ||
        el.textContent?.trim() === name),
  );
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

function sendKey(key: string, init?: KeyboardEventInit): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

function Harness() {
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        onClick: () => setOpen(true),
      },
      "Open queue",
    ),
    createElement(QueueTray, {
      open,
      onClose: () => setOpen(false),
    }),
  );
}

function VanishingOpenerHarness() {
  const [open, setOpen] = useState(false);
  const [showOpener, setShowOpener] = useState(true);
  return createElement(
    "div",
    null,
    createElement("main", { id: "main-content", tabIndex: -1 }, "Page"),
    showOpener
      ? createElement(
          "button",
          { type: "button", onClick: () => setOpen(true) },
          "Open queue",
        )
      : null,
    createElement(QueueTray, {
      open,
      onClose: () => {
        setOpen(false);
        setShowOpener(false);
      },
    }),
  );
}

describe("QueueTray accessibility", () => {
  it("focuses the tray, traps Tab, closes on Escape, and restores focus", async () => {
    const { root } = render(createElement(Harness));

    try {
      const opener = findButton("Open queue");
      opener.focus();
      expect(document.activeElement).toBe(opener);

      await act(async () => {
        opener.click();
        await flush();
      });

      const dialog = document.querySelector(
        '[role="dialog"][aria-modal="true"]',
      );
      const retryAll = findButton("Retry all");
      const close = findButton("Close");
      const discard = findButton("Discard");

      expect(dialog?.getAttribute("aria-label")).toBe("Offline queue");
      expect(document.activeElement).toBe(close);
      expect(document.body.style.overflow).toBe("hidden");

      discard.focus();
      sendKey("Tab");
      expect(document.activeElement).toBe(retryAll);

      retryAll.focus();
      sendKey("Tab", { shiftKey: true });
      expect(document.activeElement).toBe(discard);

      await act(async () => {
        sendKey("Escape");
        await flush();
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(document.body.style.overflow).toBe("");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("deduplicates a retry, reports failure, and leaves queued work actionable", async () => {
    let rejectRetry!: (reason: unknown) => void;
    mocks.flushQueuedMutations.mockReturnValue(
      new Promise((_, reject) => {
        rejectRetry = reject;
      }),
    );
    const { root } = render(createElement(Harness));
    try {
      await act(async () => {
        findButton("Open queue").click();
        await flush();
      });
      const retryAll = findButton("Retry all");
      await act(async () => {
        retryAll.click();
        retryAll.click();
        await Promise.resolve();
      });
      expect(mocks.flushQueuedMutations).toHaveBeenCalledTimes(1);
      expect(retryAll.disabled).toBe(true);
      expect(retryAll.getAttribute("aria-busy")).toBe("true");

      await act(async () => {
        rejectRetry(new Error("offline"));
        await flush();
      });
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Queued changes could not be retried. They remain in the queue.",
      );
      expect(findButton("Retry all").disabled).toBe(false);
      expect(document.body.textContent).toContain("/api/v1/forms/form_1");
    } finally {
      act(() => root.unmount());
    }
  });

  it("falls back to the main landmark when its opener disappears on close", async () => {
    const { root } = render(createElement(VanishingOpenerHarness));
    try {
      const opener = findButton("Open queue");
      opener.focus();
      await act(async () => {
        opener.click();
        await flush();
      });
      await act(async () => {
        sendKey("Escape");
        await flush();
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.textContent).not.toContain("Open queue");
      expect(document.activeElement).toBe(
        document.querySelector("main#main-content"),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("confirms discard once, isolates the top modal, and restores exact focus", async () => {
    const { root } = render(createElement(Harness));
    try {
      await act(async () => {
        findButton("Open queue").click();
        await flush();
      });
      const queue = document.querySelector(
        '[role="dialog"][aria-label="Offline queue"]',
      ) as HTMLElement;
      const discard = findButton("Discard");
      discard.focus();
      await act(async () => {
        discard.click();
        discard.click();
        await flush();
      });

      const confirmation = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"]'),
      ).find((dialog) =>
        dialog.textContent?.includes("Discard queued change?"),
      );
      expect(confirmation).toBeTruthy();
      expect(queue.getAttribute("aria-hidden")).toBe("true");
      expect(queue.hasAttribute("inert")).toBe(true);
      expect(queue.className).toContain("z-[41]");
      expect(
        Array.from(document.querySelectorAll('[role="dialog"]')).filter(
          (dialog) => dialog.getAttribute("aria-hidden") !== "true",
        ),
      ).toHaveLength(1);

      const cancel = Array.from(
        confirmation!.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Cancel")!;
      await act(async () => {
        cancel.click();
        await flush();
        await flush();
      });
      expect(document.activeElement).toBe(discard);
      expect(queue.hasAttribute("inert")).toBe(false);
      expect(queue.className).toContain("z-[71]");

      await act(async () => {
        discard.click();
        await flush();
      });
      const nextConfirmation = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"]'),
      ).find((dialog) =>
        dialog.textContent?.includes("Discard queued change?"),
      )!;
      const confirm = Array.from(
        nextConfirmation.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Discard")!;
      await act(async () => {
        confirm.click();
        confirm.click();
        await flush();
        await flush();
      });
      expect(mocks.discardOutboxItem).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(document.activeElement).toBe(findButton("Close")),
      );
      const undoOptions = mocks.toastInfo.mock.calls.find(
        (call) => call[1]?.action?.label === "Undo",
      )?.[1];
      expect(undoOptions?.action?.onClick).toBeTypeOf("function");
    } finally {
      act(() => root.unmount());
    }
  });

  it("hides and inerts the tray while its conflict resolver is the top modal", async () => {
    const item = mocks.outbox.all[0]!;
    item.status = "conflict";
    item.conflictStatus = 412;
    mocks.outbox.pending = [];
    mocks.outbox.conflicts = [item];
    mocks.outbox.pendingCount = 0;
    mocks.outbox.attentionCount = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ name: "Server form" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const { root } = render(createElement(Harness));
    try {
      await act(async () => {
        findButton("Open queue").click();
        await flush();
      });
      const queue = document.querySelector(
        '[role="dialog"][aria-label="Offline queue"]',
      ) as HTMLElement;
      const resolve = findButton("Resolve");
      await act(async () => {
        resolve.click();
        await flush();
      });
      const conflict = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"]'),
      ).find((dialog) => dialog.textContent?.includes("Resolve conflict"));
      expect(conflict).toBeTruthy();
      expect(queue.getAttribute("aria-hidden")).toBe("true");
      expect(queue.hasAttribute("inert")).toBe(true);
      expect(queue.className).toContain("z-[41]");
      expect(
        Array.from(document.querySelectorAll('[role="dialog"]')).filter(
          (dialog) => dialog.getAttribute("aria-hidden") !== "true",
        ),
      ).toHaveLength(1);

      const cancel = Array.from(
        conflict!.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Cancel")!;
      await act(async () => {
        cancel.click();
        await flush();
      });
      expect(queue.hasAttribute("aria-hidden")).toBe(false);
      expect(queue.hasAttribute("inert")).toBe(false);
      expect(queue.className).toContain("z-[71]");
    } finally {
      act(() => root.unmount());
    }
  });
});
