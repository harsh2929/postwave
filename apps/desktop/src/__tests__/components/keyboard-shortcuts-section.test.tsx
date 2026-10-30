// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { KeyboardShortcutsSection } from "../../components/settings/KeyboardShortcutsSection";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => localStorage.clear());

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

async function renderSection(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<KeyboardShortcutsSection />);
    await Promise.resolve();
  });
}

function row(label: string): HTMLTableRowElement {
  const match = [
    ...document.querySelectorAll<HTMLTableRowElement>("tbody tr"),
  ].find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Missing shortcut row: ${label}`);
  return match;
}

async function record(
  targetRow: HTMLTableRowElement,
  init: KeyboardEventInit,
): Promise<void> {
  const change = [
    ...targetRow.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent?.includes("Change"));
  await act(async () => change?.click());
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
    await Promise.resolve();
  });
}

function setSearch(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("KeyboardShortcutsSection", () => {
  it("renders a semantic searchable table and persists a collision-free remap", async () => {
    await renderSection();
    expect(document.querySelector("table caption")?.textContent).toContain(
      "Application keyboard shortcuts",
    );
    expect(document.querySelectorAll("tbody tr").length).toBeGreaterThan(10);

    const lists = row("Lists");
    await record(lists, {
      key: "J",
      code: "KeyJ",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(lists.textContent).toContain("Custom");
    expect(lists.querySelector("kbd")?.textContent).toContain("J");
    expect(document.querySelector("[role='status']")?.textContent).toContain(
      "Shortcut changed",
    );

    const stored = localStorage.getItem("postwave.desktop.shortcuts.v1");
    expect(stored).toContain("nav.lists");
  });

  it("keeps recording open on a conflict, explains the blocker, and cancels with Escape", async () => {
    await renderSection();
    const domains = row("Custom domains");
    await record(domains, {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
    });
    expect(document.body.textContent).toContain(
      "Already used by Search and commands",
    );
    expect(domains.textContent).toContain("Press shortcut…");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(domains.textContent).toContain("Change");
    expect(document.body.textContent).toContain("recording cancelled");
  });

  it("filters without destroying preferences and restores all defaults explicitly", async () => {
    await renderSection();
    await record(row("Lists"), {
      key: "J",
      code: "KeyJ",
      ctrlKey: true,
      shiftKey: true,
    });

    const search = document.querySelector<HTMLInputElement>(
      "input[type='search']",
    )!;
    await act(async () => {
      setSearch(search, "restart");
    });
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(document.body.textContent).toContain("Restart setup");

    await act(async () => {
      setSearch(search, "");
    });
    const restore = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("Restore defaults"))!;
    await act(async () => restore.click());
    expect(document.querySelector("[role='dialog']")?.textContent).toContain(
      "Restore default shortcuts?",
    );
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) =>
        button.textContent?.trim() === "Restore defaults" &&
        button.closest("[role='dialog']"),
    )!;
    await act(async () => confirm.click());
    expect(localStorage.getItem("postwave.desktop.shortcuts.v1")).not.toContain(
      "nav.lists",
    );
    expect(document.body.textContent).toContain(
      "All default shortcuts restored",
    );
  });
});
