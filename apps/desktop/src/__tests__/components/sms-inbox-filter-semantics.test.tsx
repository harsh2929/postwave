// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { InboxFilters } from "../../components/sms/InboxFilters";
import { StatusChips } from "../../components/sms/StatusChips";

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
});

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.replace(/\d+/g, "").trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

describe("SMS inbox filter semantics", () => {
  it("exposes each single-choice group and keeps filter guidance visible", async () => {
    const onFilter = vi.fn();
    const onStatus = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <>
          <StatusChips
            status="active"
            totals={{ active: 4, snoozed: 2, archived: 1, any: 7 }}
            onChange={onStatus}
          />
          <InboxFilters
            filter="unread"
            sort="recent"
            totals={{ total: 7, unread: 3, unknown: 2 }}
            onFilterChange={onFilter}
            onSortChange={vi.fn()}
          />
        </>,
      ),
    );

    expect(
      document.querySelector(
        '[role="group"][aria-label="Conversation lifecycle"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[role="group"][aria-label="Conversation filter"]',
      ),
    ).not.toBeNull();
    expect(button("Active").getAttribute("aria-pressed")).toBe("true");
    expect(button("Unread").getAttribute("aria-pressed")).toBe("true");
    expect(button("Unknown subscriber").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(document.body.textContent).toContain(
      "Unknown subscribers are phone numbers with no matched subscriber record.",
    );
    expect(document.querySelector("label")?.textContent).toContain("Sort");
    expect(document.querySelector("[title]")).toBeNull();

    act(() => button("Archived").click());
    act(() => button("Unknown subscriber").click());
    expect(onStatus).toHaveBeenCalledWith("archived");
    expect(onFilter).toHaveBeenCalledWith("unknown");

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
