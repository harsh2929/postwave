// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LibraryTagFilters } from "../../components/library/LibraryAssetStates";

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

function button(text: string): HTMLButtonElement {
  const match = Array.from(
    container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!match) throw new Error(`Missing ${text} button`);
  return match;
}

describe("LibraryTagFilters", () => {
  it("offers every loaded tag and keeps an active overflow tag visible", async () => {
    const onChange = vi.fn();
    const tags = Array.from({ length: 26 }, (_, index) => ({
      tag: `tag-${index + 1}`,
      count: index + 1,
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <LibraryTagFilters active="tag-26" tags={tags} onChange={onChange} />,
      ),
    );

    expect(container!.textContent).not.toContain("tag-25");
    expect(container!.textContent).toContain("tag-26");
    expect(container!.textContent).toContain(
      "the active tag is also kept visible",
    );
    expect(
      container!
        .querySelector('button[aria-label="tag-26, 26 tagged assets"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    const showAll = button("Show all 26 tags");
    expect(showAll.getAttribute("aria-expanded")).toBe("false");
    act(() => showAll.click());
    expect(container!.textContent).toContain("tag-25");
    expect(container!.textContent).toContain("Showing all 26 loaded tags");
    expect(button("Show fewer tags").getAttribute("aria-expanded")).toBe(
      "true",
    );

    const activeTag = container.querySelector<HTMLButtonElement>(
      'button[aria-label="tag-26, 26 tagged assets"]',
    );
    act(() => activeTag?.click());
    expect(onChange).toHaveBeenCalledWith("");

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
