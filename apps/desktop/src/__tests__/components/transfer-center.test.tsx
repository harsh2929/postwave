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

import type { TransferRecord } from "../../lib/file-transfer-types";
import { popDialog, pushDialog } from "../../lib/dialogStack";

const mocks = vi.hoisted(() => ({
  actions: [] as Array<"cancel" | "retry" | "reveal">,
  clear: vi.fn(),
  history: [] as TransferRecord[],
  runAction: vi.fn(),
}));

vi.mock("../../lib/file-transfer-history", () => ({
  clearFinishedTransferHistory: mocks.clear,
  getTransferHistory: () => mocks.history,
  runTransferAction: mocks.runAction,
  subscribeTransferHistory: () => () => undefined,
  transferActionsFor: () => mocks.actions,
}));

import { TransferCenter } from "../../components/TransferCenter";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.actions = [];
  mocks.history = [];
  vi.clearAllMocks();
  mocks.runAction.mockResolvedValue(true);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderCenter(open = true, onClose = vi.fn()): () => void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <TransferCenter open={open} onToggle={vi.fn()} onClose={onClose} />,
    );
  });
  return onClose;
}

describe("TransferCenter non-modal dialog", () => {
  it("links its trigger, enters the dialog, exposes privacy context, and passes axe", async () => {
    renderCenter();
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"]',
    );
    const panel = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(trigger?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-modal")).toBe("false");
    expect(panel?.getAttribute("aria-describedby")).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close file transfers",
    );
    expect(document.body.textContent).toContain(
      "Paths and private file names are never retained.",
    );
    const result = await axe.run(panel!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("ignores composing Escape, then closes the top dialog and restores focus", async () => {
    const onClose = renderCenter();
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"]',
    );
    const composing = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(composing, "isComposing", { value: true });
    act(() => {
      document.dispatchEvent(composing);
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => pushDialog("test:nested-over-transfers"));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => popDialog("test:nested-over-transfers"));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await act(async () => Promise.resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes once across focus departure and an outside pointer", () => {
    const onClose = renderCenter();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps visible file names in text without hover-only title reliance", () => {
    mocks.history = [
      {
        id: "transfer-1",
        direction: "download",
        label: "Subscriber export",
        fileName: "subscribers.csv",
        privacy: "confidential",
        status: "completed",
        bytesTransferred: 2048,
        totalBytes: 2048,
        startedAt: Date.now() - 1000,
        updatedAt: Date.now(),
        collision: false,
      },
    ];
    renderCenter();
    const fileName = Array.from(document.querySelectorAll("span")).find(
      (candidate) => candidate.textContent === "subscribers.csv",
    );
    expect(fileName).toBeDefined();
    expect(fileName?.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).toContain("Completed");
  });

  it("single-flights an action and exposes honest pending and success states", async () => {
    let finish: ((value: boolean) => void) | null = null;
    mocks.actions = ["retry"];
    mocks.runAction.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    mocks.history = [
      {
        id: "transfer-1",
        direction: "download",
        label: "Subscriber export",
        fileName: "subscribers.csv",
        privacy: "public",
        status: "failed",
        bytesTransferred: 0,
        totalBytes: 2048,
        startedAt: Date.now() - 1000,
        updatedAt: Date.now(),
        collision: false,
      },
    ];
    renderCenter();
    const retry = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Retry",
    )!;

    act(() => {
      retry.click();
      retry.click();
    });
    expect(mocks.runAction).not.toHaveBeenCalled();
    expect(retry.disabled).toBe(true);
    expect(document.body.textContent).toContain("Retrying…");

    await act(async () => Promise.resolve());
    expect(mocks.runAction).toHaveBeenCalledOnce();
    await act(async () => {
      finish?.(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Retry started.");
    expect(retry.disabled).toBe(false);
  });

  it("contains synchronous action failures without leaking adapter detail", async () => {
    mocks.actions = ["reveal"];
    mocks.runAction.mockImplementationOnce(() => {
      throw new Error("/private/customer/path/secret.csv");
    });
    mocks.history = [
      {
        id: "transfer-1",
        direction: "download",
        label: "Subscriber export",
        fileName: "subscribers.csv",
        privacy: "public",
        status: "completed",
        bytesTransferred: 2048,
        totalBytes: 2048,
        startedAt: Date.now() - 1000,
        updatedAt: Date.now(),
        collision: false,
      },
    ];
    renderCenter();
    const reveal = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Show in folder",
    )!;
    act(() => reveal.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "Show in folder could not be completed",
    );
    expect(document.body.textContent).not.toContain("/private/customer/path");
  });

  it("drops a late transfer action completion after its row unmounts", async () => {
    let finish: ((value: boolean) => void) | undefined;
    mocks.actions = ["retry"];
    mocks.runAction.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    mocks.history = [
      {
        id: "transfer-1",
        direction: "download",
        label: "Subscriber export",
        fileName: "subscribers.csv",
        privacy: "public",
        status: "failed",
        bytesTransferred: 0,
        totalBytes: 2048,
        startedAt: Date.now() - 1000,
        updatedAt: Date.now(),
        collision: false,
      },
    ];
    renderCenter();
    const retry = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Retry",
    )!;
    act(() => retry.click());
    await act(async () => Promise.resolve());
    act(() => root?.render(<div>Transfer row removed</div>));

    await act(async () => {
      finish?.(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Transfer row removed");
    expect(document.body.textContent).not.toContain("Retry started");
  });
});
