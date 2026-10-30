// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RowMenu } from "@/app/(dashboard)/app/subscribers/segments/segments-list";
import type { Segment } from "@/lib/segments-api";

import { importBeforeTests, waitFor } from "../pages/_wait";

// The confirmation loads on first open (DeferredConfirmDialog); warm its
// module so no test pays the cold import on its own clock.
importBeforeTests(() => import("@/components/ui/confirm-dialog"));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SEGMENT: Segment = {
  id: "segment-delete-contract",
  tenantId: "tenant-demo",
  name: "Delete contract segment",
  description: "A deterministic audience.",
  queryAst: { op: "and", children: [] },
  createdAt: "2026-08-25T09:00:00Z",
  updatedAt: "2026-08-25T09:00:00Z",
};

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

function buttonByText(text: string, scope: ParentNode = document) {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function trigger() {
  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-label="More actions for Delete contract segment"]',
  );
  if (!button) throw new Error("Row menu trigger not found");
  return button;
}

function dialog() {
  const node = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!node) throw new Error("Delete dialog not found");
  return node;
}

async function openDeleteDialog() {
  await act(async () => trigger().click());
  const menu = document.querySelector('[role="menu"]');
  if (!menu) throw new Error("Row menu not found");
  await act(async () => buttonByText("Delete", menu).click());
  await waitFor(() => dialog());
}

function rowMenu(onDelete: () => void | Promise<void>) {
  return (
    <RowMenu
      segment={SEGMENT}
      onDelete={onDelete}
      onDuplicate={vi.fn()}
      onUseInCampaign={vi.fn()}
      folders={[]}
      onMoveToFolder={vi.fn()}
    />
  );
}

describe("segment RowMenu delete ownership", () => {
  it("keeps the dialog mounted outside the menu and restores cancel focus", async () => {
    mount(rowMenu(vi.fn()));
    const returnTarget = trigger();
    await openDeleteDialog();

    expect(document.querySelector('[role="menu"]')).toBeNull();
    const cancel = buttonByText("Cancel", dialog());
    // This mousedown is outside RowMenu's DOM root because the dialog is in a
    // portal. It must not unmount the controlled dialog before click lands.
    await act(async () =>
      cancel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      cancel.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(returnTarget);
  });

  it("invokes one asynchronous confirmation and freezes dismissal while pending", async () => {
    const gate = deferred();
    const onDelete = vi.fn(() => gate.promise);
    mount(rowMenu(onDelete));
    const returnTarget = trigger();
    await openDeleteDialog();

    const pendingDialog = dialog();
    const confirm = buttonByText("Delete", pendingDialog);
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      confirm.click();
      confirm.click();
      await Promise.resolve();
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(pendingDialog.getAttribute("aria-busy")).toBe("true");
    expect(buttonByText("Cancel", pendingDialog).disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      gate.resolve();
      await gate.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(returnTarget);
  });

  it("moves focus to a connected header fallback when success removes the row", async () => {
    const gate = deferred();
    const onDelete = vi.fn(() => gate.promise);

    function RemovingRow() {
      const [present, setPresent] = useState(true);
      const fallbackRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={fallbackRef} type="button">
            New segment
          </button>
          {present ? (
            <RowMenu
              segment={SEGMENT}
              onDelete={async () => {
                await onDelete();
                setPresent(false);
              }}
              onDuplicate={vi.fn()}
              onUseInCampaign={vi.fn()}
              folders={[]}
              onMoveToFolder={vi.fn()}
              deleteFallbackFocusRef={fallbackRef}
            />
          ) : null}
        </>
      );
    }

    mount(<RemovingRow />);
    await openDeleteDialog();
    await act(async () => buttonByText("Delete", dialog()).click());
    expect(onDelete).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve();
      await gate.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe("New segment");
  });
});
