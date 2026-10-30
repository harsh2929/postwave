// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LibrarySelectionBar } from "../../components/library/LibrarySelectionBar";
import { InboxBulkBar } from "../../components/sms/InboxBulkBar";
import { TagBulkBar } from "../../components/tags/TagBulkBar";
import { BulkActionsBar } from "../../components/webhooks/BulkActionsBar";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

async function expectNoSeriousAxeViolations(): Promise<void> {
  const results = await axe.run(container!, {
    rules: { region: { enabled: false } },
  });
  expect(
    results.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

describe("selection action bars", () => {
  it("uses an ordinary action group and a visible, shortcut-labelled clear action", async () => {
    const onClear = vi.fn();
    const onMerge = vi.fn();
    render(
      <TagBulkBar
        count={2}
        canDelete
        onClear={onClear}
        onDelete={vi.fn()}
        onMerge={onMerge}
        onRecolour={vi.fn()}
        onDescribe={vi.fn()}
      />,
    );

    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    expect(
      document.querySelector('[role="group"]')?.getAttribute("aria-label"),
    ).toBe("Tag actions");
    expect(document.querySelector("[title]")).toBeNull();
    act(() => button("Merge…").click());
    expect(onMerge).toHaveBeenCalledTimes(1);
    const clear = button("✕ Clear");
    expect(clear.getAttribute("aria-keyshortcuts")).toBe("Escape");
    act(() => clear.click());
    expect(onClear).toHaveBeenCalledTimes(1);
    await expectNoSeriousAxeViolations();
  });

  it("gives the SMS clear action a visible name", () => {
    const onClear = vi.fn();
    render(
      <InboxBulkBar
        count={3}
        onClear={onClear}
        onArchive={vi.fn()}
        onSnooze={vi.fn()}
      />,
    );
    expect(button("✕ Clear").getAttribute("aria-keyshortcuts")).toBe("Escape");
    expect(document.querySelector("[title]")).toBeNull();
    act(() => button("✕ Clear").click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("explains the viewer-safe Library action set without hiding clear", () => {
    const onClear = vi.fn();
    render(
      <LibrarySelectionBar
        count={2}
        canMutate={false}
        onCopyUrls={vi.fn()}
        onDelete={vi.fn()}
        onClear={onClear}
      />,
    );
    expect(document.body.textContent).toContain(
      "Viewer access can copy URLs only.",
    );
    expect(document.body.textContent).not.toContain("Delete");
    expect(button("✕ Clear")).toBeTruthy();
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("gives busy webhook actions native disabled semantics and honest status", async () => {
    const onEnable = vi.fn();
    const onClear = vi.fn();
    const renderBar = (busy: boolean): void =>
      render(
        <BulkActionsBar
          count={4}
          canEnable
          canDisable
          canDelete
          busy={busy}
          onClear={onClear}
          onEnableAll={onEnable}
          onDisableAll={vi.fn()}
          onDeleteAll={vi.fn()}
        />,
      );
    renderBar(true);

    const enable = button("Re-enable all");
    expect(enable.disabled).toBe(true);
    expect(enable.hasAttribute("aria-disabled")).toBe(false);
    act(() => {
      enable.click();
      enable.click();
      button("✕ Clear").click();
    });
    expect(onEnable).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Applying bulk action…");

    renderBar(false);
    act(() => button("Re-enable all").click());
    expect(onEnable).toHaveBeenCalledTimes(1);
    await expectNoSeriousAxeViolations();
  });
});
