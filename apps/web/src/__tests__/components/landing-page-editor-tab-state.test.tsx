// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  LANDING_PAGE_EDITOR_TABS,
  parseLandingPageEditorTab,
  useLandingPageEditorTab,
} from "@/app/(dashboard)/app/landing-pages/[id]/tab-url-state";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

function TabHarness({ initialValue }: { initialValue: string | null }) {
  const [activeTab, changeTab] = useLandingPageEditorTab(initialValue);

  return createElement(
    "div",
    null,
    createElement("output", { "data-testid": "active-tab" }, activeTab),
    ...LANDING_PAGE_EDITOR_TABS.map((tab) =>
      createElement(
        "button",
        { key: tab, type: "button", onClick: () => changeTab(tab) },
        tab,
      ),
    ),
  );
}

function renderHarness(initialValue: string | null): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(TabHarness, { initialValue })));
  return root;
}

function activeTab(): string | null {
  return (
    document.querySelector('[data-testid="active-tab"]')?.textContent ?? null
  );
}

function clickTab(tab: string): void {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === tab,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${tab} tab control`);
  }
  act(() => button.click());
}

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("landing-page editor tab URL state", () => {
  it.each(LANDING_PAGE_EDITOR_TABS)(
    "recognizes the visible %s tab",
    (tab) => {
      expect(parseLandingPageEditorTab(tab)).toBe(tab);
    },
  );

  it("falls back to Content for missing and unknown tab values", () => {
    expect(parseLandingPageEditorTab(null)).toBe("content");
    expect(parseLandingPageEditorTab("unknown")).toBe("content");
  });

  it("restores deep links and synchronizes Back/Forward URL changes", () => {
    const nextHistoryState = { __NA: true, key: "landing-page-editor" };
    window.history.replaceState(
      nextHistoryState,
      "",
      "/app/landing-pages/lp_1?source=campaign&tab=variants#editor",
    );
    const root = renderHarness("variants");

    try {
      expect(activeTab()).toBe("variants");

      clickTab("history");
      expect(activeTab()).toBe("history");
      expect(window.location.search).toBe("?source=campaign&tab=history");
      expect(window.location.hash).toBe("#editor");
      expect(window.history.state).toEqual(nextHistoryState);

      window.history.replaceState(
        window.history.state,
        "",
        "/app/landing-pages/lp_1?source=campaign&tab=variants#editor",
      );
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      expect(activeTab()).toBe("variants");

      window.history.replaceState(
        window.history.state,
        "",
        "/app/landing-pages/lp_1?source=campaign&tab=history#editor",
      );
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      expect(activeTab()).toBe("history");
    } finally {
      act(() => root.unmount());
    }
  });

  it("uses the canonical Content URL without dropping other URL state", () => {
    window.history.replaceState(
      { __NA: true },
      "",
      "/app/landing-pages/lp_1?source=campaign&tab=history#editor",
    );
    const root = renderHarness("history");

    try {
      clickTab("content");
      expect(activeTab()).toBe("content");
      expect(window.location.search).toBe("?source=campaign");
      expect(window.location.hash).toBe("#editor");
    } finally {
      act(() => root.unmount());
    }
  });
});
