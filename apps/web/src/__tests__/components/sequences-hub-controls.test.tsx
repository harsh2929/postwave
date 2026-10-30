// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SequenceListItem } from "@/lib/voice-types";
const mocks = vi.hoisted(() => ({
  duplicate: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));
const router = { replace: mocks.replace, refresh: mocks.refresh };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/app/sequences",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/lib/voice-api", () => ({
  duplicateSequence: mocks.duplicate,
  archiveSequence: vi.fn(),
  unarchiveSequence: vi.fn(),
}));
vi.mock("@/app/(dashboard)/app/sequences/_components/row-actions", () => ({
  SequenceRowActions: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { SequencesHub } from "@/app/(dashboard)/app/sequences/_components/sequences-hub";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
const rows: SequenceListItem[] = Array.from({ length: 16 }, (_, i) => ({
  id: `seq-${i + 1}`,
  name: `QA ${String(i + 1).padStart(3, "0")}`,
  templateName: "Manual",
  status: "draft",
  fidelityAvg: i,
  updatedAt: "2026-10-24T00:00:00Z",
  emailCount: 1,
}));
beforeEach(() => {
  window.history.replaceState(null, "", "/app/sequences");
  mocks.replace.mockImplementation((url: string) =>
    window.history.replaceState(null, "", url),
  );
  mocks.duplicate.mockResolvedValue({});
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
function button(name: string): HTMLElement {
  const el = [
    ...document.querySelectorAll<HTMLElement>(
      'button,[role="checkbox"],input[type="checkbox"]',
    ),
  ].find(
    (x) => (x.getAttribute("aria-label") ?? x.textContent?.trim()) === name,
  );
  if (!el) throw new Error("Missing " + name);
  return el;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function render() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(SequencesHub, { rows })));
}
function links() {
  return [
    ...document.querySelectorAll<HTMLAnchorElement>(
      'table a[href^="/app/sequences/seq-"]',
    ),
  ];
}
it("sorts and paginates, keeps cross-page selection, and bulk duplicates every selected row once", async () => {
  await render();
  expect(links()).toHaveLength(15);
  expect((button("Prev") as HTMLButtonElement).disabled).toBe(true);
  await click("Name");
  expect(links()[0].textContent).toBe("QA 001");
  expect(
    document.querySelector('th[aria-sort="ascending"]')?.textContent,
  ).toContain("Name");
  await click("Next");
  expect(links().map((a) => a.textContent)).toEqual(["QA 016"]);
  expect((button("Next") as HTMLButtonElement).disabled).toBe(true);
  await click("Select all on this page");
  expect(document.body.textContent).toContain("1 selected");
  await click("Prev");
  await click("Select all on this page");
  expect(document.body.textContent).toContain("16 selected");
  await click("Duplicate");
  for (let n = 0; n < 20 && mocks.duplicate.mock.calls.length < 16; n++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(mocks.duplicate.mock.calls.map(([id]) => id).sort()).toEqual(
    rows.map((r) => r.id).sort(),
  );
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
it("shows filter-empty results and clears filters back to the first page", async () => {
  await render();
  await click("Next");
  const select = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Filter by status"]',
  )!;
  await act(async () => {
    select.value = "archived";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.body.textContent).toContain(
    "No sequences match your filters",
  );
  expect(links()).toHaveLength(0);
  await click("Clear filters");
  expect(links()).toHaveLength(15);
  expect(document.body.textContent).toContain("1–15 of 16");
});
