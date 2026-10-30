// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { WindowedList } from "../../components/virtualization/WindowedList";

interface Item {
  id: string;
  label: string;
}

const ITEMS: readonly Item[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `item-${index}`,
  label: `Item ${index + 1}`,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function LargeList(): ReactElement {
  return (
    <WindowedList
      label="Large audit fixture"
      items={ITEMS}
      getKey={(item) => item.id}
      renderItem={(item) => <button type="button">{item.label}</button>}
      height={320}
      itemHeight={32}
      totalCount={12_000}
      overscan={4}
    />
  );
}

describe("windowed list large-data contract", () => {
  it("bounds DOM rows for 10,000 items while exposing complete positions", () => {
    render(<LargeList />);
    const list = document.querySelector<HTMLElement>('[role="list"]')!;
    const rows = document.querySelectorAll('[role="listitem"]');
    expect(list.getAttribute("aria-label")).toBe("Large audit fixture");
    expect(rows.length).toBeLessThanOrEqual(18);
    expect(rows[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(rows[0]?.getAttribute("aria-setsize")).toBe("12000");
    expect(list.getAttribute("data-windowed-count")).toBe(String(rows.length));
  });

  it("renders the scrolled range and keeps a focused off-screen row mounted", () => {
    render(<LargeList />);
    const list = document.querySelector<HTMLElement>('[role="list"]')!;
    const first = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Item 1",
    )!;
    act(() => first.focus());
    expect(document.activeElement).toBe(first);

    act(() => {
      list.scrollTop = 5_000 * 32;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Item 5001");
    expect(document.body.textContent).toContain("Item 1");
    expect(document.activeElement).toBe(first);
    expect(
      document.querySelectorAll('[role="listitem"]').length,
    ).toBeLessThanOrEqual(19);
  });

  it("presents an honest non-virtual empty state", () => {
    render(
      <WindowedList
        label="Empty fixture"
        items={[] as Item[]}
        getKey={(item) => item.id}
        renderItem={(item) => item.label}
        height={320}
        itemHeight={32}
        emptyState="No matching audit events."
      />,
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "No matching audit events.",
    );
    expect(document.querySelector('[role="list"]')).toBeNull();
  });
});
