// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearOfflineStorage,
  getOfflineStorageIdentity,
  OFFLINE_QUEUE_CHANGED_EVENT,
  registerOfflineStorageRuntimeReset,
  resetOfflineStorageIdentity,
  setOfflineStorageIdentity,
} from "@/lib/offline-storage-identity";

afterEach(() => {
  registerOfflineStorageRuntimeReset(() => undefined);
  resetOfflineStorageIdentity();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("offline storage identity boundary", () => {
  it("purges loaded runtime state synchronously before publishing a new identity", () => {
    const observed: Array<string | null> = [];
    registerOfflineStorageRuntimeReset(() => {
      observed.push(getOfflineStorageIdentity());
    });

    setOfflineStorageIdentity("user-a", "tenant-a");
    setOfflineStorageIdentity("user-b", "tenant-b");

    expect(observed).toEqual([null, "user-a:tenant-a"]);
    expect(getOfflineStorageIdentity()).toBe("user-b:tenant-b");
  });

  it("clears legacy plaintext records and announces an empty queue", () => {
    window.localStorage.setItem(
      "postwave.web.offline-mutations.v2:user-a:tenant-a",
      "private",
    );
    window.localStorage.setItem("unrelated", "keep");
    const counts: number[] = [];
    window.addEventListener(OFFLINE_QUEUE_CHANGED_EVENT, (event) => {
      counts.push((event as CustomEvent<{ count: number }>).detail.count);
    });

    setOfflineStorageIdentity("user-a", "tenant-a");
    clearOfflineStorage();

    expect(
      window.localStorage.getItem(
        "postwave.web.offline-mutations.v2:user-a:tenant-a",
      ),
    ).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
    expect(getOfflineStorageIdentity()).toBeNull();
    expect(counts).toEqual([0, 0]);
  });
});
