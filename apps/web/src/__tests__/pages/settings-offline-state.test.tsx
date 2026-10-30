// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OfflineSettingsPage from "@/app/(dashboard)/app/settings/offline/page";
import {
  readOfflineQueue,
  resetOfflineStorageIdentity,
  setOfflineStorageIdentity,
  writeOfflineQueue,
  type OfflineMutation,
} from "@/lib/offline-store";

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  flushQueuedMutations: mocks.flush,
}));

vi.mock("@/lib/online-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/online-manager")>()),
  getOnlineStatus: () => "online",
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.success,
    warning: mocks.warning,
    error: mocks.error,
    message: mocks.message,
  },
}));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

function item(
  id: string,
  status: OfflineMutation["status"],
  attempts = 0,
): OfflineMutation {
  return {
    id,
    method: "PATCH",
    path: `/api/v1/forms/${id}`,
    body: { name: id },
    idempotencyKey: `idem-${id}`,
    queuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    attempts,
    status,
    resource: "forms",
    ...(status === "conflict" ? { conflictStatus: 412 as const } : {}),
  };
}

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return root;
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${name}`);
  }
  return match;
}

function dialogButton(name: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll('[role="dialog"] button'),
  ).find((candidate) => candidate.textContent?.trim() === name);
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`dialog button not found: ${name}`);
  }
  return match;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  setOfflineStorageIdentity("offline-test-user", "offline-test-tenant");
  mocks.flush.mockReset();
  mocks.success.mockReset();
  mocks.warning.mockReset();
  mocks.error.mockReset();
  mocks.message.mockReset();
});

afterEach(() => {
  resetOfflineStorageIdentity();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("settings/offline queue decisions", () => {
  it("retries failed and stopped work once without reissuing a conflict", async () => {
    writeOfflineQueue([
      item("failed-item", "failed", 5),
      item("stopped-item", "dead-letter", 6),
      item("conflict-item", "conflict", 1),
    ]);
    let finishFlush:
      | ((value: {
          replayed: number;
          conflicts: number;
          failed: number;
        }) => void)
      | undefined;
    mocks.flush.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFlush = resolve;
        }),
    );
    const root = render(createElement(OfflineSettingsPage));
    await settle();

    try {
      const failedSummary = Array.from(document.querySelectorAll("div")).find(
        (candidate) =>
          candidate.firstElementChild?.textContent?.trim() === "Failed",
      );
      expect(failedSummary?.textContent).toContain("2");
      expect(document.body.textContent).toContain("stopped");

      const retryAll = button("Retry all failed");
      act(() => {
        retryAll.click();
        retryAll.click();
      });
      await settle();

      expect(mocks.flush).toHaveBeenCalledTimes(1);
      expect(button("Resolve").disabled).toBe(true);
      expect(button("Discard all").disabled).toBe(true);
      expect(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            'button[aria-label^="Discard "]',
          ),
        ).every((control) => control.disabled),
      ).toBe(true);
      const queued = readOfflineQueue();
      expect(
        queued.map(({ id, status, attempts }) => ({ id, status, attempts })),
      ).toEqual([
        { id: "failed-item", status: "pending", attempts: 0 },
        { id: "stopped-item", status: "pending", attempts: 0 },
        { id: "conflict-item", status: "conflict", attempts: 1 },
      ]);

      await act(async () =>
        finishFlush?.({ replayed: 0, conflicts: 0, failed: 2 }),
      );
      await settle();
      expect(mocks.warning).toHaveBeenCalledWith(
        "2 queued changes need attention.",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not present conflicts as bulk-retryable or automatically syncable", async () => {
    writeOfflineQueue([item("conflict-only", "conflict", 1)]);
    const root = render(createElement(OfflineSettingsPage));
    await settle();

    try {
      expect(button("Retry all failed").disabled).toBe(true);
      expect(button("Sync pending").disabled).toBe(true);
      expect(button("Resolve").disabled).toBe(false);
      expect(
        document.querySelector('button[aria-label^="Discard Update form"]'),
      ).toBeInstanceOf(HTMLButtonElement);
      expect(mocks.flush).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("confirms a bulk discard and undo merges work queued afterward", async () => {
    const first = item("first-item", "pending");
    const second = item("second-item", "failed", 1);
    writeOfflineQueue([first, second]);
    const root = render(createElement(OfflineSettingsPage));
    await settle();

    try {
      act(() => button("Discard all").click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(readOfflineQueue().map(({ id }) => id)).toEqual([
        "first-item",
        "second-item",
      ]);

      await act(async () => {
        dialogButton("Discard all").click();
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        // ConfirmDialog retries focus restoration through the Radix portal's
        // exit frames because this successful action disables its own trigger.
        // Wait for that public focus contract instead of racing the unmount.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(readOfflineQueue()).toEqual([]);
      expect(document.activeElement?.textContent).toBe("Offline Sync");

      act(() => writeOfflineQueue([item("newer-item", "pending")]));
      const call = mocks.success.mock.calls.find(
        ([message]) => message === "2 queued changes discarded.",
      );
      const options = call?.[1] as
        | { action?: { label?: string; onClick?: () => void } }
        | undefined;
      expect(options?.action?.label).toBe("Undo");
      act(() => options?.action?.onClick?.());

      expect(readOfflineQueue().map(({ id }) => id)).toEqual([
        "first-item",
        "second-item",
        "newer-item",
      ]);
    } finally {
      act(() => root.unmount());
    }
  });
});
