// @vitest-environment happy-dom

import axe from "axe-core";
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

import { DashboardToolbar } from "../../components/dashboard/DashboardToolbar";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function toolbar(onShare: () => Promise<boolean>): ReactElement {
  return (
    <DashboardToolbar
      range="30d"
      loading={false}
      onRangeChange={vi.fn()}
      onRefresh={vi.fn()}
      onShare={onShare}
    />
  );
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DashboardToolbar share feedback", () => {
  it("keeps refresh single-flight until its controller settles", async () => {
    const pending = deferred<void>();
    const onRefresh = vi.fn().mockReturnValue(pending.promise);
    render(
      <DashboardToolbar
        range="30d"
        loading={false}
        onRangeChange={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    const refresh = button("Refresh");
    act(() => {
      refresh.click();
      refresh.click();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(button("Refreshing…").getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(button("Refresh")).toBeTruthy();
  });

  it("does not let a prior range's refresh lock or clear the current range", async () => {
    const oldRefresh = deferred<void>();
    const newRefresh = deferred<void>();
    const onRefresh = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(oldRefresh.promise)
      .mockReturnValueOnce(newRefresh.promise);
    render(
      <DashboardToolbar
        range="30d"
        loading={false}
        onRangeChange={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    act(() => button("Refresh").click());
    expect(button("Refreshing…")).toBeTruthy();

    act(() =>
      root?.render(
        <DashboardToolbar
          range="7d"
          loading={false}
          onRangeChange={vi.fn()}
          onRefresh={onRefresh}
        />,
      ),
    );
    act(() => button("Refresh").click());
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(button("Refreshing…")).toBeTruthy();

    await act(async () => {
      oldRefresh.resolve();
      await oldRefresh.promise;
    });
    expect(button("Refreshing…")).toBeTruthy();

    await act(async () => {
      newRefresh.resolve();
      await newRefresh.promise;
    });
    expect(button("Refresh")).toBeTruthy();
  });

  it("locks layout mode while its latest order is saving", () => {
    const onToggle = vi.fn();
    render(
      <DashboardToolbar
        range="30d"
        loading={false}
        onRangeChange={vi.fn()}
        onRefresh={vi.fn()}
        editingLayout
        layoutSaving
        onToggleEditLayout={onToggle}
      />,
    );

    const saving = button("Saving layout…");
    expect(saving.getAttribute("aria-disabled")).toBe("true");
    expect(saving.getAttribute("aria-busy")).toBe("true");
    expect(saving.getAttribute("aria-label")).toBe("Saving dashboard layout");
    act(() => saving.click());
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("shows Copied only after the clipboard action confirms success", async () => {
    const onShare = vi.fn().mockResolvedValue(false);
    render(toolbar(onShare));
    act(() => button("Share").click());
    await flush();

    expect(onShare).toHaveBeenCalledTimes(1);
    expect(button("Retry share")).toBeTruthy();
    expect(document.body.textContent).toContain("Copy failed. Try again.");
    expect(document.body.textContent).not.toContain("Copied!");
  });

  it("serializes clicks, reports success, and clears its timer", async () => {
    const pending = deferred<boolean>();
    const onShare = vi.fn().mockReturnValue(pending.promise);
    render(toolbar(onShare));
    act(() => button("Share").click());
    act(() => button("Copying…").click());

    expect(onShare).toHaveBeenCalledTimes(1);
    expect(button("Copying…").disabled).toBe(false);
    expect(button("Copying…").getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(button("Copied!")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(button("Share")).toBeTruthy();
  });

  it("does not let an older success timer erase a newer copy failure", async () => {
    const onShare = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    render(toolbar(onShare));

    act(() => button("Share").click());
    await flush();
    expect(button("Copied!")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => button("Copied!").click());
    await flush();
    expect(button("Retry share")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(button("Retry share")).toBeTruthy();
    expect(document.body.textContent).toContain("Copy failed. Try again.");
  });

  it("ignores completion after unmount", async () => {
    const pending = deferred<boolean>();
    render(toolbar(() => pending.promise));
    act(() => button("Share").click());
    act(() => root?.unmount());
    root = null;

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(document.body.textContent).not.toContain("Copied!");
  });

  it("surfaces thrown clipboard failures and allows a retry", async () => {
    const onShare = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("clipboard unavailable"))
      .mockResolvedValueOnce(true);
    render(toolbar(onShare));

    act(() => button("Share").click());
    await flush();
    expect(button("Retry share")).toBeTruthy();
    expect(document.body.textContent).toContain("Copy failed. Try again.");

    act(() => button("Retry share").click());
    await flush();
    expect(onShare).toHaveBeenCalledTimes(2);
    expect(button("Copied!")).toBeTruthy();
  });

  it("uses explicit range names, guarded refresh, and no native title tooltips", async () => {
    const onRangeChange = vi.fn();
    const onRefresh = vi.fn();
    render(
      <DashboardToolbar
        range="30d"
        loading
        onRangeChange={onRangeChange}
        onRefresh={onRefresh}
        onToggleEditLayout={vi.fn()}
      />,
    );

    expect(document.querySelector("[title]")).toBeNull();
    expect(button("30d").getAttribute("aria-label")).toBe("Last 30 days");
    act(() => button("7d").click());
    expect(onRangeChange).toHaveBeenCalledWith("7d");

    const refresh = button("Refreshing…");
    expect(refresh.disabled).toBe(false);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    refresh.focus();
    expect(document.activeElement).toBe(refresh);
    act(() => refresh.click());
    expect(onRefresh).not.toHaveBeenCalled();

    vi.useRealTimers();
    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
