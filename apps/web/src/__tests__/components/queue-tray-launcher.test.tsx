// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// QueueTrayLauncher is the ONLY way to reach the offline queue while online
// (SHELL-019): before it existed, a user told on reconnect that a replay had
// conflicted could not open the tray without a reload, which discards the
// queue. Nothing rendered it, so neither the visibility rule nor the
// `pw:open-queue-tray` listener was exercised.
//
// The outbox here is the REAL store (src/lib/offline-store memory queue),
// seeded through its own public API, so the snapshot bucketing that decides
// what the badge says is exercised rather than hand-stubbed. Only
// flushQueuedMutations is replaced — the tray's "Retry all" would otherwise
// drive live replay.
//
// Falsifiable claims:
//   - one queued FAILED item ⇒ badge visible, counted, and named for the
//     "needs attention" case (a silent icon-only button is unusable)
//   - PENDING items are the banner's job while offline, so the header button
//     stays hidden unless the connection is back
//   - the event opens the tray even with nothing queued (the reason the
//     component exists)
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickEveryControl,
  renderPage,
  stubFixtureTransport,
  unmount,
} from "../pages/_harness";
import {
  enqueueOfflineMutation,
  resetOfflineStorageIdentity,
  setOfflineStorageIdentity,
  updateOfflineMutation,
} from "@/lib/offline-store";

const mocks = vi.hoisted(() => ({
  conn: "online" as "online" | "connecting" | "offline",
  flush: vi.fn(async () => ({
    replayed: 0,
    failed: 0,
    conflicts: 0,
    dead: 0,
  })),
}));

vi.mock("@/lib/use-online", () => ({ useOnline: () => mocks.conn }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  flushQueuedMutations: mocks.flush,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

function seedFailedItem(): string {
  const item = enqueueOfflineMutation({
    method: "PATCH",
    path: "/api/v1/forms/form_42",
    body: { name: "Newsletter signup" },
  });
  updateOfflineMutation(item.id, {
    status: "failed",
    attempts: 2,
    lastError: "Network request failed",
  });
  return item.id;
}

beforeEach(() => {
  stubFixtureTransport();
  mocks.conn = "online";
  mocks.flush.mockClear();
  resetOfflineStorageIdentity();
  setOfflineStorageIdentity("u_test", "t_test");
});

afterEach(() => {
  resetOfflineStorageIdentity();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("QueueTrayLauncher", () => {
  it("shows a named, counted badge when an item needs attention", async () => {
    seedFailedItem();
    const { QueueTrayLauncher } =
      await import("@/components/queue-tray-launcher");
    const { container, root } = await renderPage(QueueTrayLauncher);
    try {
      const button = container.querySelector("button");
      expect(button).not.toBeNull();
      expect(button?.getAttribute("aria-label")).toBe(
        "Offline queue — 1 item needs attention",
      );
      // The count is the visible half of the same fact.
      expect(button?.textContent).toBe("1");
      // Tray stays shut until asked.
      expect(container.querySelector("[role='dialog']")).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("opens the tray on click and lists the failed item", async () => {
    seedFailedItem();
    const { QueueTrayLauncher } =
      await import("@/components/queue-tray-launcher");
    const { container, root } = await renderPage(QueueTrayLauncher);
    try {
      const launcher = container.querySelector("button")!;
      const panelId = launcher.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      await act(async () => {
        launcher.click();
        await new Promise((r) => setTimeout(r, 0));
      });

      const tray = container.querySelector("[role='dialog']");
      expect(tray?.id).toBe(panelId);
      expect(tray?.getAttribute("aria-label")).toBe("Offline queue");
      expect(tray?.textContent).toContain("Queue (1)");
      expect(tray?.textContent).toContain("Failed");
      expect(tray?.textContent).toContain("/api/v1/forms/form_42");
      expect(tray?.textContent).toContain("Network request failed");

      // Then press everything inside — Retry, Discard, Retry all, Close.
      const { clicked, failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      expect(clicked).toBeGreaterThan(2);
      // "Retry all" routes to the replay entry point rather than doing its
      // own thing.
      expect(mocks.flush).toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("pluralises the label for several items needing attention", async () => {
    seedFailedItem();
    seedFailedItem();
    const { QueueTrayLauncher } =
      await import("@/components/queue-tray-launcher");
    const { container, root } = await renderPage(QueueTrayLauncher);
    try {
      expect(
        container.querySelector("button")?.getAttribute("aria-label"),
      ).toBe("Offline queue — 2 items need attention");
      expect(container.querySelector("button")?.textContent).toBe("2");
    } finally {
      unmount(root);
    }
  });

  it("hides the header button for pending items while not yet back online", async () => {
    // Pending-while-offline is the OfflineBanner's job; duplicating it in the
    // header is the case this guard exists to exclude.
    mocks.conn = "offline";
    enqueueOfflineMutation({
      method: "PATCH",
      path: "/api/v1/segments/seg_1",
      body: { name: "VIPs" },
    });
    const { QueueTrayLauncher } =
      await import("@/components/queue-tray-launcher");
    const offline = await renderPage(QueueTrayLauncher);
    try {
      expect(offline.container.querySelector("button")).toBeNull();
    } finally {
      unmount(offline.root);
    }

    // Guard the guard: the same seeded queue DOES surface once the connection
    // is back, so the absence above is the rule firing and not an empty store.
    mocks.conn = "online";
    const online = await renderPage(QueueTrayLauncher);
    try {
      expect(
        online.container.querySelector("button")?.getAttribute("aria-label"),
      ).toBe("Offline queue — 1 syncing");
    } finally {
      unmount(online.root);
    }
  });

  it("opens on the pw:open-queue-tray event even with an empty queue", async () => {
    const { QueueTrayLauncher, OPEN_QUEUE_TRAY_EVENT } =
      await import("@/components/queue-tray-launcher");
    const { container, root } = await renderPage(QueueTrayLauncher);
    try {
      // Nothing queued, so there is no header button at all — the event is
      // the only route in, which is what the reconnect toast's "Review"
      // action relies on.
      expect(container.querySelector("button")).toBeNull();

      await act(async () => {
        window.dispatchEvent(new Event(OPEN_QUEUE_TRAY_EVENT));
        await new Promise((r) => setTimeout(r, 0));
      });

      const tray = container.querySelector("[role='dialog']");
      expect(tray).not.toBeNull();
      expect(tray?.textContent).toContain("No queued changes");
    } finally {
      unmount(root);
    }
  });
});
