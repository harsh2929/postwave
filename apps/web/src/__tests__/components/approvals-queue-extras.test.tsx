// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-72 / 75: search/sort/reset over the loaded approvals window and
// the automatic queue refresh (60 s interval, focus, online, visibility).
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApprovalsAutoRefresh,
  APPROVALS_REFRESH_INTERVAL_MS,
} from "@/components/approvals/approvals-auto-refresh";
import {
  ApprovalsSearchSortBar,
  useApprovalsSearchSort,
} from "@/components/approvals/approvals-search-sort-bar";
import type { Approval } from "@/lib/approvals-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(window.navigator, "onLine");
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(ui));
  return root;
}

function approval(overrides: Partial<Approval> & { id: string }): Approval {
  return {
    tenantId: "tnt_1",
    resourceType: "campaign",
    resourceId: `res_${overrides.id}`,
    status: "pending",
    requestedAt: "2026-09-01T00:00:00Z",
    expiresAt: "2026-12-01T00:00:00Z",
    ...overrides,
  };
}

const ROWS: Approval[] = [
  approval({
    id: "a1",
    requestedAt: "2026-09-02T00:00:00Z",
    resourceType: "sequence",
    resourceId: "seq_9",
    requestedByActorLabel: "Zed Admin",
    status: "rejected",
    notes: "Budget exceeded for Q4",
  }),
  approval({
    id: "a2",
    requestedAt: "2026-09-04T00:00:00Z",
    resourceType: "campaign",
    resourceId: "cmp_2",
    requestedByActorType: "agent",
    requestedByActorLabel: "ops-bot",
  }),
  approval({
    id: "a3",
    requestedAt: "2026-09-01T00:00:00Z",
    resourceType: "automation_send",
    resourceId: "auto_1",
    requestedByUserId: "usr_amy",
    status: "approved",
  }),
  approval({
    id: "a4",
    requestedAt: "2026-09-03T00:00:00Z",
    resourceType: "campaign",
    resourceId: "cmp_1",
    requestedByActorLabel: "Bea",
  }),
];

function Harness({ rows }: { rows: Approval[] }) {
  const searchSort = useApprovalsSearchSort(rows);
  return createElement(
    "div",
    null,
    createElement(ApprovalsSearchSortBar, searchSort.barProps),
    createElement(
      "ul",
      { "data-testid": "rows" },
      searchSort.visible.map((row) =>
        createElement("li", { key: row.id, "data-id": row.id }, row.id),
      ),
    ),
  );
}

function visibleIds(): string[] {
  return Array.from(
    document.querySelectorAll('[data-testid="rows"] li'),
  ).map((row) => row.getAttribute("data-id") ?? "");
}

function setValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    "value",
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function search(): HTMLInputElement {
  const input = document.querySelector("#approvals-search");
  if (!(input instanceof HTMLInputElement)) throw new Error("no search");
  return input;
}

function sort(): HTMLSelectElement {
  const select = document.querySelector("#approvals-sort");
  if (!(select instanceof HTMLSelectElement)) throw new Error("no sort");
  return select;
}

function resetButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Reset",
  );
}

describe("ApprovalsSearchSortBar (governance-72)", () => {
  it("searches the loaded rows across resource, requester, status and reason", () => {
    render(createElement(Harness, { rows: ROWS }));
    expect(visibleIds()).toEqual(["a2", "a4", "a1", "a3"]);
    expect(resetButton()).toBeUndefined();

    act(() => setValue(search(), "OPS-BOT"));
    expect(visibleIds()).toEqual(["a2"]);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Showing 1 of 4 loaded approvals",
    );

    act(() => setValue(search(), "budget"));
    expect(visibleIds()).toEqual(["a1"]);
    act(() => setValue(search(), "automation send"));
    expect(visibleIds()).toEqual(["a3"]);
    act(() => setValue(search(), "usr_amy"));
    expect(visibleIds()).toEqual(["a3"]);
    act(() => setValue(search(), "approved"));
    expect(visibleIds()).toEqual(["a3"]);
    act(() => setValue(search(), "nothing matches this"));
    expect(visibleIds()).toEqual([]);
  });

  it("sorts by oldest, resource, requester and status, then resets", () => {
    render(createElement(Harness, { rows: ROWS }));

    act(() => setValue(sort(), "oldest"));
    expect(visibleIds()).toEqual(["a3", "a1", "a4", "a2"]);
    act(() => setValue(sort(), "resource"));
    // "Automation send auto_1" < "Campaign cmp_1" < "Campaign cmp_2" < "Sequence seq_9"
    expect(visibleIds()).toEqual(["a3", "a4", "a2", "a1"]);
    act(() => setValue(sort(), "requester"));
    // Bea < ops-bot < usr_amy < Zed Admin (case-insensitive)
    expect(visibleIds()).toEqual(["a4", "a2", "a3", "a1"]);
    act(() => setValue(sort(), "status"));
    expect(visibleIds()).toEqual(["a3", "a2", "a4", "a1"]);

    act(() => setValue(search(), "campaign"));
    expect(visibleIds()).toEqual(["a2", "a4"]);
    const reset = resetButton();
    if (!reset) throw new Error("Reset should be offered while filtered");
    act(() => reset.click());
    expect(search().value).toBe("");
    expect(sort().value).toBe("newest");
    expect(visibleIds()).toEqual(["a2", "a4", "a1", "a3"]);
    expect(resetButton()).toBeUndefined();
  });

  it("never mutates the loaded window it sorts", () => {
    const rows = [...ROWS];
    render(createElement(Harness, { rows }));
    act(() => setValue(sort(), "oldest"));
    expect(rows.map((row) => row.id)).toEqual(["a1", "a2", "a3", "a4"]);
  });
});

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("ApprovalsAutoRefresh (governance-75)", () => {
  it("refreshes every 60 s and on focus, online and visibility while visible", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const onRefresh = vi.fn(async () => undefined);
    render(createElement(ApprovalsAutoRefresh, { enabled: true, onRefresh }));
    expect(document.body.textContent).toContain(
      "The queue refreshes every minute while this tab is visible",
    );

    await tick(APPROVALS_REFRESH_INTERVAL_MS - 1);
    expect(onRefresh).toHaveBeenCalledTimes(0);
    await tick(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(APPROVALS_REFRESH_INTERVAL_MS).toBe(60_000);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await tick(0);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await tick(0);
    expect(onRefresh).toHaveBeenCalledTimes(3);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(0);
    expect(onRefresh).toHaveBeenCalledTimes(4);

    setVisibility("hidden");
    await tick(APPROVALS_REFRESH_INTERVAL_MS);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(0);
    expect(onRefresh).toHaveBeenCalledTimes(4);
  });

  it("skips while offline and coalesces overlapping triggers", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    let release: () => void = () => undefined;
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(createElement(ApprovalsAutoRefresh, { enabled: true, onRefresh }));

    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
    });
    await tick(APPROVALS_REFRESH_INTERVAL_MS);
    expect(onRefresh).toHaveBeenCalledTimes(0);
    Reflect.deleteProperty(window.navigator, "onLine");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(0);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
    await tick(0);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await tick(0);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing until the caller enables it, and stops on unmount", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const onRefresh = vi.fn(async () => undefined);
    const root = render(
      createElement(ApprovalsAutoRefresh, { enabled: false, onRefresh }),
    );
    await tick(APPROVALS_REFRESH_INTERVAL_MS * 2);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");

    act(() =>
      root.render(
        createElement(ApprovalsAutoRefresh, { enabled: true, onRefresh }),
      ),
    );
    await tick(APPROVALS_REFRESH_INTERVAL_MS);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await tick(APPROVALS_REFRESH_INTERVAL_MS * 2);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
