// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/desktop-router", async () => {
  const { useState } = await import("react");
  return {
    useDesktopRouteTab: <Value extends string>(
      _section: string,
      _allowed: readonly Value[],
      fallback: Value,
    ) => useState<Value>(fallback),
  };
});

vi.mock("../../pages/subscribers/SubscribersBrowseSection", () => ({
  SubscribersBrowseSection: () => <div data-testid="directory-content" />,
}));

vi.mock("../../pages/subscribers/SubscribersPageOverlays", () => ({
  SubscribersPageOverlays: () => <div data-testid="overlay-root" />,
}));

vi.mock("../../pages/subscribers/SubscribersTopPanels", () => ({
  SubscribersPageHeader: () => <header data-testid="page-header" />,
  SubscribersInsightsPanels: () => <div data-testid="insights-content" />,
  SubscribersGovernancePanels: () => <div data-testid="governance-content" />,
  SubscribersRulesPanels: () => <div data-testid="rules-content" />,
}));

vi.mock("../../pages/subscribers/SubscribersSegmentsPanels", () => ({
  SubscribersSegmentsPanels: () => <div data-testid="segments-content" />,
}));

import { SubscribersPagePresentation } from "../../pages/subscribers/SubscribersPagePresentation";
import type { SubscribersPageController } from "../../pages/subscribers/useSubscribersPageController";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function controller(): SubscribersPageController {
  return {
    saved: {
      savedSegments: [{ id: "segment-1" }, { id: "segment-2" }],
    },
  } as unknown as SubscribersPageController;
}

function renderPresentation(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<SubscribersPagePresentation controller={controller()} />);
  });
}

function tabs(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
}

function press(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("Subscribers page workspace navigation", () => {
  it("is directory-first, manually activated, state-preserving, and APG complete", async () => {
    renderPresentation();

    const tablist = document.querySelector(
      '[role="tablist"][aria-label="Subscriber workspaces"]',
    );
    expect(tablist).not.toBeNull();
    const items = tabs();
    expect(items).toHaveLength(5);
    expect(items[0]?.textContent).toBe("Directory");
    expect(items[1]?.textContent).toBe("Insights");
    expect(items[2]?.textContent).toContain("Segments");
    expect(items[2]?.textContent).toContain("2 saved");
    expect(items[3]?.textContent).toBe("Governance");
    expect(items[4]?.textContent).toBe("Rules & fields");
    expect(items[0]?.getAttribute("aria-selected")).toBe("true");
    expect(items[0]?.tabIndex).toBe(0);
    expect(
      document.querySelector('[data-testid="directory-content"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="insights-content"]'),
    ).toBeNull();

    act(() => items[0]?.focus());
    press(items[0]!, "ArrowRight");
    expect(document.activeElement).toBe(items[1]);
    expect(items[0]?.getAttribute("aria-selected")).toBe("true");

    press(items[1]!, "Enter");
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelector('[data-testid="directory-content"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="insights-content"]'),
    ).not.toBeNull();
    expect(
      document
        .querySelector('[data-testid="directory-content"]')
        ?.closest('[role="tabpanel"]')
        ?.hasAttribute("hidden"),
    ).toBe(true);

    act(() => tabs()[2]?.click());
    expect(
      document.querySelector('[data-testid="segments-content"]'),
    ).not.toBeNull();
    act(() => tabs()[3]?.click());
    expect(
      document
        .querySelector('[data-testid="segments-content"]')
        ?.closest('[role="tabpanel"]')
        ?.hasAttribute("hidden"),
    ).toBe(true);

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });
});
