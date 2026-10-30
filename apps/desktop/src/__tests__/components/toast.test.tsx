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

import {
  flushToastOperationsForTests,
  resetToastStateForTests,
  toast,
  ToastHost,
} from "../../components/Toast";
import { criticalNoticeStorageKeyForTests } from "../../lib/toast-critical-notices";

vi.mock("../../lib/telemetry", () => ({ track: vi.fn() }));

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
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  act(() => resetToastStateForTests());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function notices(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".toast")];
}

describe("Toast notification contract", () => {
  it("deduplicates stable identities and bounds the visible stack", () => {
    render(<ToastHost />);

    act(() => {
      toast.info({ id: "sync", message: "Sync queued" });
      toast.info({ id: "sync", message: "Sync is running" });
      toast.success("First task finished");
      toast.info("Second task started");
    });

    expect(notices()).toHaveLength(3);
    expect(document.body.textContent).toContain("Sync is running");
    expect(document.body.textContent).not.toContain("Sync queued");

    act(() => toast.soon("Another event"));
    expect(notices()).toHaveLength(3);
  });

  it("keeps errors readable longer and uses one live-region owner", () => {
    render(<ToastHost />);
    act(() => {
      toast.info("Short notice");
      toast.error("Recoverable failure");
    });

    expect(
      document.querySelector(".toast-host")?.hasAttribute("aria-live"),
    ).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Recoverable failure",
    );

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(document.body.textContent).not.toContain("Short notice");
    expect(document.body.textContent).toContain("Recoverable failure");

    act(() => {
      vi.advanceTimersByTime(4500);
    });
    expect(notices()).toHaveLength(0);
  });

  it("pauses expiry while hovered and while the document is hidden", () => {
    render(<ToastHost />);
    act(() => toast.info("Inspect this notice"));
    const notice = notices()[0];
    if (!notice) throw new Error("Expected a notice");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      notice.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(document.body.textContent).toContain("Inspect this notice");

    act(() => {
      notice.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(document.body.textContent).toContain("Inspect this notice");

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(notices()).toHaveLength(0);
  });

  it("contains rejected actions and converts the notice to a retryable error", async () => {
    render(<ToastHost />);
    act(() =>
      toast.info({
        message: "Export ready",
        action: {
          label: "Reveal",
          onClick: () => Promise.reject(new Error("private path")),
        },
      }),
    );

    const action = document.querySelector<HTMLButtonElement>(".toast-action");
    await act(async () => {
      action?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const notice = notices()[0];
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toContain("could not be completed");
    expect(notice?.textContent).not.toContain("private path");
  });

  it("supports progress notices with an explicit named dismiss action", () => {
    render(<ToastHost />);
    act(() => {
      toast.progress("Connection needs attention");
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(notices()).toHaveLength(1);

    const dismiss = document.querySelector<HTMLButtonElement>(".toast-dismiss");
    expect(dismiss?.getAttribute("aria-label")).toContain(
      "Connection needs attention",
    );
    act(() => dismiss?.click());
    expect(notices()).toHaveLength(0);
  });

  it("restores catalogued critical failures without persisting their copy", async () => {
    render(<ToastHost />);
    await act(async () => {
      toast.critical("campaign-draft-recovery-unavailable");
      await flushToastOperationsForTests();
    });

    const raw = window.localStorage.getItem(criticalNoticeStorageKeyForTests);
    expect(raw).toContain("campaign-draft-recovery-unavailable");
    expect(raw).not.toContain("Campaign recovery needs attention");
    expect(raw).not.toContain("campaign draft");
    expect(notices()).toHaveLength(1);

    act(() => resetToastStateForTests({ preservePersistedCritical: true }));
    expect(notices()).toHaveLength(0);
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;

    render(<ToastHost />);
    await act(async () => flushToastOperationsForTests());
    expect(document.body.textContent).toContain(
      "Campaign recovery needs attention",
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    const dismiss = document.querySelector<HTMLButtonElement>(".toast-dismiss");
    await act(async () => {
      dismiss?.click();
      await flushToastOperationsForTests();
    });
    expect(window.localStorage.getItem(criticalNoticeStorageKeyForTests)).toBe(
      null,
    );
  });

  it("deduplicates identical critical announcements and clears on recovery", async () => {
    render(<ToastHost />);
    await act(async () => {
      toast.critical("campaign-draft-recovery-unavailable");
      toast.critical("campaign-draft-recovery-unavailable");
      await flushToastOperationsForTests();
    });
    expect(notices()).toHaveLength(1);

    await act(async () => {
      toast.resolveCritical("campaign-draft-recovery-unavailable");
      await flushToastOperationsForTests();
    });
    expect(notices()).toHaveLength(0);
    expect(window.localStorage.getItem(criticalNoticeStorageKeyForTests)).toBe(
      null,
    );
  });

  it("keeps the critical failure visible when local persistence is denied", async () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "QuotaExceededError");
    });
    render(<ToastHost />);
    await act(async () => {
      toast.critical("campaign-draft-recovery-unavailable");
      await flushToastOperationsForTests();
    });

    expect(document.body.textContent).toContain(
      "Campaign recovery needs attention",
    );
    expect(window.localStorage.getItem(criticalNoticeStorageKeyForTests)).toBe(
      null,
    );
  });

  it("serializes an immediate critical raise and recovery", async () => {
    render(<ToastHost />);
    await act(async () => {
      toast.critical("campaign-draft-recovery-unavailable");
      toast.resolveCritical("campaign-draft-recovery-unavailable");
      await flushToastOperationsForTests();
    });

    expect(notices()).toHaveLength(0);
    expect(window.localStorage.getItem(criticalNoticeStorageKeyForTests)).toBe(
      null,
    );
  });
});
