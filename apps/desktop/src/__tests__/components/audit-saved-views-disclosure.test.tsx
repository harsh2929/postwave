// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listAuditSavedViews: mocks.list,
    createAuditSavedView: mocks.create,
    deleteAuditSavedView: mocks.remove,
  },
}));

import { SavedViewsBar } from "../../components/audit/SavedViewsBar";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue({ data: { views: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(canManage = true): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <SavedViewsBar
        canManage={canManage}
        currentFilters={{ actor: "admin" }}
        onLoad={vi.fn()}
      />,
    ),
  );
}

function saveTrigger(): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.includes("Save current"),
  );
  if (!found) throw new Error("Missing save-current trigger");
  return found;
}

async function settle(): Promise<void> {
  await act(async () => Promise.resolve());
}

describe("SavedViewsBar disclosure", () => {
  it("keeps mutation affordances structurally absent for read-only auditors", async () => {
    mocks.list.mockResolvedValue({
      data: {
        views: [{ id: "view-1", name: "SOC 2", filters: { days: 30 } }],
      },
    });
    render(false);
    await settle();

    expect(document.querySelector('select[aria-label="Saved views"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Save current");
    expect(document.body.textContent).not.toContain("Delete");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("owns exact relationships, labels, IME Escape, and focus restoration", async () => {
    render();
    await settle();
    const trigger = saveTrigger();
    act(() => trigger.click());
    const region = document.querySelector<HTMLElement>('[role="region"]');
    expect(region).not.toBeNull();
    expect(trigger.getAttribute("aria-controls")).toBe(region?.id);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const name = document.querySelector<HTMLInputElement>('input[placeholder^="Name"]');
    expect(document.activeElement).toBe(name);
    expect(name?.labels?.[0]?.textContent).toContain("Saved view name");
    expect(document.body.textContent).toContain("Enter a name to enable Save");
    act(() => {
      name?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
          isComposing: true,
        }),
      );
    });
    expect(document.querySelector('[role="region"]')).not.toBeNull();
    act(() => {
      name?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });
    await settle();
    expect(document.querySelector('[role="region"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
