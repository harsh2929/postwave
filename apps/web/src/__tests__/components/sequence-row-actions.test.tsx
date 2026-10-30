// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  restore: vi.fn(),
  duplicate: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/voice-api", () => ({
  archiveSequence: mocks.archive,
  unarchiveSequence: mocks.restore,
  duplicateSequence: mocks.duplicate,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { SequenceRowActionsMenu } from "@/app/(dashboard)/app/sequences/_components/row-actions-menu";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const el = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!el) throw new Error("Missing button " + text);
  return el;
}
async function render(status: "draft" | "archived" = "draft") {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      createElement(SequenceRowActionsMenu, {
        id: "seq-qa",
        status,
        initialOpen: true,
      }),
    ),
  );
}
async function clickWithPointer(text: string, scope: ParentNode = document) {
  const target = button(text, scope);
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  expect(target.isConnected).toBe(true);
  await act(async () => target.click());
}
it("keeps the portalled archive confirmation mounted through pointerdown and submits once", async () => {
  mocks.archive.mockResolvedValue(undefined);
  await render();
  await clickWithPointer("Archive");
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  await clickWithPointer("Archive", dialog!);
  expect(mocks.archive).toHaveBeenCalledExactlyOnceWith("seq-qa");
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("allows cancellation without archiving and leaves the menu available", async () => {
  await render();
  await clickWithPointer("Archive");
  await clickWithPointer("Cancel", document.querySelector('[role="dialog"]')!);
  expect(mocks.archive).not.toHaveBeenCalled();
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
});
it("restores an archived sequence to draft", async () => {
  mocks.restore.mockResolvedValue(undefined);
  await render("archived");
  await clickWithPointer("Restore to draft");
  expect(mocks.restore).toHaveBeenCalledExactlyOnceWith("seq-qa");
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
