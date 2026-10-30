// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowListCard } from "@/app/(dashboard)/app/flows/_components/flow-list-card";
import type { Flow } from "@/lib/flows-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
});
const flow = {
  id: "flow-qa",
  name: "Welcome",
  status: "draft",
  version: 1,
  graph: { nodes: [] },
} as unknown as Flow;
function props() {
  return {
    flow,
    triggerCatalog: [],
    pinned: false,
    onTogglePin: vi.fn(),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDuplicate: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onCopyLink: vi.fn(),
    tags: [],
    onSetTags: vi.fn(),
  };
}
async function mount(value: ReturnType<typeof props>) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(FlowListCard, value)));
}
function button(label: string) {
  const result = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (element) =>
      element.getAttribute("aria-label") === label ||
      element.textContent?.trim() === label,
  );
  expect(result, label).toBeTruthy();
  return result!;
}
describe("flow card lifecycle controls", () => {
  it("keeps archived flows restorable after the Undo toast has gone", async () => {
    const value = props();
    value.flow = { ...flow, status: "archived" };
    await mount(value);
    expect(document.querySelector('[aria-label="Archive flow"]')).toBeNull();
    await act(async () => button("Restore flow to draft").click());
    expect(value.onRestore).toHaveBeenCalledExactlyOnceWith(value.flow);
    await act(async () =>
      root!.render(createElement(FlowListCard, { ...value, canWrite: false })),
    );
    expect(button("Restore flow to draft").disabled).toBe(true);
  });

  it("requires archive confirmation and leaves Cancel harmless", async () => {
    const value = props();
    await mount(value);
    await act(async () => button("Archive flow").click());
    expect(value.onArchive).not.toHaveBeenCalled();
    await act(async () => button("Cancel").click());
    expect(value.onArchive).not.toHaveBeenCalled();
    await act(async () => button("Archive flow").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const confirm = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>("button"),
    ).find((element) => element.textContent?.trim() === "Archive flow")!;
    await act(async () =>
      confirm.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    );
    await act(async () => confirm.click());
    expect(value.onArchive).toHaveBeenCalledExactlyOnceWith(flow);
  });
});
