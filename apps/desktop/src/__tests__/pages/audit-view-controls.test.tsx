// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AuditViewModeToolbar,
  AuditViewReleaseHold,
} from "../../pages/audit/AuditViewControls";

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
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function mount(node: React.ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

describe("audit view controls", () => {
  it("keeps incomplete density views focusable, described, and inert", () => {
    const onChange = vi.fn();
    mount(<AuditViewModeToolbar viewMode="list" onChange={onChange} />);
    const heatmap = container?.querySelector<HTMLInputElement>(
      '[data-testid="audit-view-mode-heatmap"]',
    );
    expect(heatmap?.type).toBe("radio");
    expect(heatmap?.checked).toBe(false);
    expect(heatmap?.getAttribute("aria-disabled")).toBe("true");
    const description = heatmap?.getAttribute("aria-describedby");
    expect(document.getElementById(description ?? "")?.textContent).toContain(
      "complete-window density data",
    );
    expect(container?.querySelector("legend")?.textContent).toBe(
      "Audit evidence views",
    );
    act(() => heatmap?.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("recovers a persisted held mode into the authoritative event list", () => {
    const onChange = vi.fn();
    mount(<AuditViewModeToolbar viewMode="timeline" onChange={onChange} />);
    const list = container?.querySelector<HTMLInputElement>(
      '[data-testid="audit-view-mode-list"]',
    );
    act(() => list?.click());
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("list");
  });

  it("explains a persisted held view and offers an explicit path to the list", () => {
    const useList = vi.fn();
    mount(<AuditViewReleaseHold viewMode="timeline" onUseList={useList} />);
    expect(container?.textContent).toContain("Timeline is on release hold");
    const action = Array.from(container?.querySelectorAll("button") ?? []).find(
      (candidate) => candidate.textContent === "Use event list",
    );
    act(() => action?.click());
    expect(useList).toHaveBeenCalledOnce();
  });
});
