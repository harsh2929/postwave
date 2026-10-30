// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { FilteredNoMatchEmptyState } from "../../components/subscribers/FilteredNoMatchEmptyState";
import {
  clearRecentSubscriberSearches,
  pushRecentSubscriberSearch,
} from "../../components/subscribers/recent-searches";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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
  clearRecentSubscriberSearches();
  sessionStorage.clear();
});

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

describe("FilteredNoMatchEmptyState", () => {
  it("keeps recovery choices self-describing without native tooltips", async () => {
    pushRecentSubscriberSearch("scope-a", "@example.com");
    pushRecentSubscriberSearch("scope-a", "tag:customer");
    const onApply = vi.fn();
    const onClear = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <FilteredNoMatchEmptyState
          recentSearchScope="scope-a"
          query="acme"
          onApplyQuery={onApply}
          onClear={onClear}
        />,
      ),
    );

    expect(document.body.textContent).toContain("No matches for “acme”");
    expect(document.body.textContent).toContain("subscribers carrying a tag");
    expect(document.querySelector("[title]")).toBeNull();
    expect(button("tag:customer").getAttribute("aria-label")).toBe(
      "Search again for tag:customer",
    );

    act(() => button("name:acme").click());
    act(() => button("tag:customer").click());
    act(() => button("tag:vipsubscribers carrying a tag").click());
    act(() => button("Clear search").click());
    expect(onApply.mock.calls.map(([query]) => query)).toEqual([
      "name:acme",
      "tag:customer",
      "tag:vip",
    ]);
    expect(onClear).toHaveBeenCalledTimes(1);

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
