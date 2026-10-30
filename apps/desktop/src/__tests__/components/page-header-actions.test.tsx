// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PageHeader } from "../../components/PageHeader";

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

function renderHeader(onRefresh: () => void, onCreate: () => void): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <PageHeader
        title="Subscribers"
        subtitle="Manage the active audience."
        actions={[
          {
            label: "Refresh",
            onClick: onRefresh,
            disabled: true,
            title: "The audience is already refreshing.",
          },
          {
            label: "Create",
            onClick: onCreate,
            title: "Create a subscriber manually.",
          },
        ]}
      />,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

describe("PageHeader action semantics", () => {
  it("keeps unavailable actions focusable, guarded, and visibly explained", async () => {
    const onRefresh = vi.fn();
    const onCreate = vi.fn();
    renderHeader(onRefresh, onCreate);

    const refresh = button("Refresh");
    expect(refresh.disabled).toBe(false);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    refresh.focus();
    expect(document.activeElement).toBe(refresh);
    act(() => refresh.click());
    expect(onRefresh).not.toHaveBeenCalled();

    const reasonId = refresh.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId ?? "");
    expect(reason?.textContent).toBe("The audience is already refreshing.");
    expect(reason?.className).toBe("page-header-v2-action-reason");

    expect(container?.querySelector("[title]")).toBeNull();
    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("preserves enabled action guidance without replacing the visible name", () => {
    const onCreate = vi.fn();
    renderHeader(vi.fn(), onCreate);

    const create = button("Create");
    expect(create.getAttribute("aria-disabled")).toBeNull();
    expect(create.getAttribute("aria-label")).toBeNull();
    const descriptionId = create.getAttribute("aria-describedby");
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "Create a subscriber manually.",
    );
    expect(document.getElementById(descriptionId ?? "")?.className).toBe(
      "visually-hidden",
    );
    act(() => create.click());
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
