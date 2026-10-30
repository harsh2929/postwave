// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DEFAULT_KPI_LAYOUT,
  KpiConfigMenu,
  type KpiEntry,
  loadLayout,
  saveLayout,
} from "../../components/analytics/KpiConfigMenu";
import { SavedViewsMenu } from "../../components/analytics/SavedViewsMenu";
import { SAVED_VIEWS_VAULT_NAMESPACE } from "../../components/analytics/saved-views-storage";
import { sensitiveLocalVaultKey } from "../../lib/sensitive-local-data";
import { vaultSetJSON } from "../../lib/secure-vault";

const SAVED_VIEWS_SCOPE = "aaaaaaaaaaaaaaaa";
const SECOND_SAVED_VIEWS_SCOPE = "bbbbbbbbbbbbbbbb";
const SAVED_VIEWS_KEY = `postwave.analytics.saved-views.v1:${SAVED_VIEWS_SCOPE}`;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => Promise.resolve());
    }
  }
  throw failure;
}

async function seedEncryptedViews(
  scope: string,
  views: Array<{
    id: string;
    name: string;
    range: "7d" | "30d" | "90d";
    vsPrevious: boolean;
  }>,
): Promise<void> {
  await vaultSetJSON(
    sensitiveLocalVaultKey(SAVED_VIEWS_VAULT_NAMESPACE, scope),
    { version: 1, value: views },
  );
}

async function pressWindow(key: string, composing = false): Promise<void> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true });
  if (composing) Object.defineProperty(event, "isComposing", { value: true });
  act(() => {
    window.dispatchEvent(event);
  });
  await act(async () => Promise.resolve());
}

function dialogTrigger(name: string): HTMLButtonElement {
  const trigger = Array.from(
    container?.querySelectorAll<HTMLButtonElement>(
      'button[aria-haspopup="dialog"]',
    ) ?? [],
  ).find((button) => button.getAttribute("aria-label") === name);
  expect(trigger).not.toBeUndefined();
  return trigger!;
}

function ViewsTrigger(): HTMLButtonElement {
  const trigger = container?.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="dialog"]:not([aria-label])',
  );
  expect(trigger).not.toBeNull();
  return trigger!;
}

function KpiHarness({ initial }: { initial?: KpiEntry[] }): ReactElement {
  const [layout, setLayout] = useState<KpiEntry[]>(
    () => initial ?? DEFAULT_KPI_LAYOUT.map((entry) => ({ ...entry })),
  );
  return <KpiConfigMenu layout={layout} onChange={setLayout} />;
}

describe("analytics dialog-popover interactions", () => {
  it("models Saved Views as a named multi-action dialog and preserves delete focus", async () => {
    await seedEncryptedViews(SAVED_VIEWS_SCOPE, [
        { id: "weekly", name: "Weekly check", range: "7d", vsPrevious: true },
        {
          id: "quarter",
          name: "Quarter review",
          range: "90d",
          vsPrevious: false,
        },
      ]);
    const onApply = vi.fn();
    render(
      <SavedViewsMenu
        current={{ range: "90d", vsPrevious: false }}
        onApply={onApply}
        storageScope={SAVED_VIEWS_SCOPE}
      />,
    );

    await waitFor(() =>
      expect(container?.textContent).toContain("View · Quarter review"),
    );
    const trigger = ViewsTrigger();
    click(trigger);
    const dialog = container?.querySelector<HTMLElement>(
      '.analytics-popup--saved-views[role="dialog"]',
    );
    expect(dialog).not.toBeNull();
    expect(container?.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.getAttribute("aria-controls")).toBe(dialog?.id);
    expect(dialog?.getAttribute("aria-labelledby")).not.toBeNull();
    expect(document.activeElement?.textContent).toContain("Weekly check");

    const firstDelete = dialog?.querySelector<HTMLButtonElement>(
      '[aria-label="Delete saved view Weekly check"]',
    );
    click(firstDelete ?? null);
    await waitFor(() => {
      expect(dialog?.textContent).not.toContain("Weekly check");
      expect(document.activeElement?.textContent).toContain("Quarter review");
      expect(container?.querySelector('[role="status"]')?.textContent).toContain(
        "Deleted saved view Weekly check",
      );
    });

    click(document.activeElement);
    await act(async () => Promise.resolve());
    expect(onApply).toHaveBeenCalledWith({
      id: "quarter",
      name: "Quarter review",
      range: "90d",
      vsPrevious: false,
    });
    expect(
      container?.querySelector(".analytics-popup--saved-views"),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);

    click(trigger);
    await pressWindow("Escape", true);
    expect(
      container?.querySelector(".analytics-popup--saved-views"),
    ).not.toBeNull();
    await pressWindow("Escape");
    expect(
      container?.querySelector(".analytics-popup--saved-views"),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("isolates encrypted saved views and purges all ambiguous plaintext without reading it", async () => {
    localStorage.setItem(
      "postwave.analytics.saved-views.v1",
      JSON.stringify([
        { id: "legacy", name: "Other client", range: "7d", vsPrevious: true },
      ]),
    );
    localStorage.setItem(
      SAVED_VIEWS_KEY,
      JSON.stringify([
        { id: "alpha", name: "Alpha view", range: "30d", vsPrevious: false },
      ]),
    );
    localStorage.setItem(
      `postwave.analytics.saved-views.v1:${SECOND_SAVED_VIEWS_SCOPE}`,
      JSON.stringify([
        { id: "beta", name: "Beta view", range: "90d", vsPrevious: true },
      ]),
    );
    await seedEncryptedViews(SAVED_VIEWS_SCOPE, [
      { id: "alpha", name: "Alpha view", range: "30d", vsPrevious: false },
    ]);
    await seedEncryptedViews(SECOND_SAVED_VIEWS_SCOPE, [
      { id: "beta", name: "Beta view", range: "90d", vsPrevious: true },
    ]);
    const originalGet = localStorage.getItem.bind(localStorage);
    const reads: string[] = [];
    vi.spyOn(localStorage, "getItem").mockImplementation((key: string) => {
      reads.push(key);
      return originalGet(key);
    });
    render(
      <SavedViewsMenu
        current={{ range: "30d", vsPrevious: false }}
        onApply={vi.fn()}
        storageScope={SAVED_VIEWS_SCOPE}
      />,
    );
    await waitFor(() =>
      expect(container?.textContent).toContain("View · Alpha view"),
    );
    click(ViewsTrigger());
    expect(container?.textContent).toContain("Alpha view");
    expect(container?.textContent).not.toContain("Other client");
    expect(originalGet("postwave.analytics.saved-views.v1")).toBeNull();
    expect(originalGet(SAVED_VIEWS_KEY)).toBeNull();
    expect(
      originalGet(
        `postwave.analytics.saved-views.v1:${SECOND_SAVED_VIEWS_SCOPE}`,
      ),
    ).toBeNull();
    expect(reads).not.toContain("postwave.analytics.saved-views.v1");
    expect(reads).not.toContain(SAVED_VIEWS_KEY);

    act(() => {
      root?.render(
        <SavedViewsMenu
          current={{ range: "90d", vsPrevious: true }}
          onApply={vi.fn()}
          storageScope={SECOND_SAVED_VIEWS_SCOPE}
        />,
      );
    });
    expect(container?.textContent).not.toContain("Alpha view");
    await waitFor(() =>
      expect(container?.textContent).toContain("View · Beta view"),
    );
    expect(container?.textContent).not.toContain("Other client");
  });

  it("moves from Saved Views into its naming modal and returns to the trigger", async () => {
    render(
      <SavedViewsMenu
        current={{ range: "30d", vsPrevious: true }}
        onApply={vi.fn()}
        storageScope={SAVED_VIEWS_SCOPE}
      />,
    );
    const trigger = ViewsTrigger();
    click(trigger);
    await waitFor(() =>
      expect(
        container
          ?.querySelector<HTMLButtonElement>("[data-saved-view-create]")
          ?.getAttribute("aria-disabled"),
      ).toBeNull(),
    );
    const create = container?.querySelector<HTMLButtonElement>(
      "[data-saved-view-create]",
    );
    expect(document.activeElement).toBe(create);
    click(create ?? null);

    const modal = container?.querySelector<HTMLElement>(
      '.modal-card[role="dialog"]',
    );
    expect(modal?.textContent).toContain("Save current view");
    const input = modal?.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input?.id).not.toBe("saved-view-name");
    expect(document.activeElement).toBe(input);
    const cancel = Array.from(modal?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    click(cancel ?? null);
    await act(async () => Promise.resolve());
    expect(container?.querySelector(".modal-card")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("enters KPI Config, announces native-button reorder, and restores on Escape", async () => {
    render(<KpiHarness />);
    const trigger = dialogTrigger("Configure KPI cards");
    click(trigger);
    const dialog = container?.querySelector<HTMLElement>(
      '.analytics-popup--kpi[role="dialog"]',
    );
    expect(dialog).not.toBeNull();
    expect(trigger.getAttribute("aria-controls")).toBe(dialog?.id);
    expect(document.activeElement).toBe(dialog);
    expect(dialog?.textContent).toContain("Move up and Move down buttons");

    const moveDown = dialog?.querySelector<HTMLButtonElement>(
      '[aria-label="Move Subscribers down"]',
    );
    click(moveDown ?? null);
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain(
      "Subscribers moved to position 2 of 8",
    );
    const rows = Array.from(dialog?.querySelectorAll("li") ?? []);
    expect(rows[0]?.textContent).toContain("Open rate");
    expect(rows[1]?.textContent).toContain("Subscribers");

    await pressWindow("Escape", true);
    expect(container?.querySelector(".analytics-popup--kpi")).not.toBeNull();
    await pressWindow("Escape");
    expect(container?.querySelector(".analytics-popup--kpi")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("isolates KPI layout persistence by identity scope", () => {
    localStorage.setItem(
      "postwave.analytics.kpi-layout.v1",
      JSON.stringify([{ key: "revenue", visible: true }]),
    );
    const alpha = DEFAULT_KPI_LAYOUT.map((entry) => ({ ...entry }));
    alpha.reverse();
    saveLayout("alpha-scope", alpha);

    expect(loadLayout("alpha-scope")[0]?.key).toBe(alpha[0]?.key);
    expect(loadLayout("beta-scope")[0]?.key).toBe(DEFAULT_KPI_LAYOUT[0]?.key);
    expect(localStorage.getItem("postwave.analytics.kpi-layout.v1")).toBeNull();

    const beta = DEFAULT_KPI_LAYOUT.map((entry, index) => ({
      ...entry,
      visible: index < 4,
    }));
    saveLayout("beta-scope", beta);
    expect(loadLayout("beta-scope")).toEqual(beta);
    expect(loadLayout("alpha-scope")[0]?.key).toBe(alpha[0]?.key);
  });

  it("visibly explains KPI visibility limits and closes on focus departure", () => {
    const initial = DEFAULT_KPI_LAYOUT.map((entry, index) => ({
      ...entry,
      visible: index < 4,
    }));
    render(<KpiHarness initial={initial} />);
    const trigger = dialogTrigger("Configure KPI cards");
    click(trigger);
    const checkbox = container?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkbox?.disabled).toBe(true);
    const reasonId = checkbox?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(reasonId)?.textContent).toBe(
      "Keep at least 4 cards visible.",
    );

    act(() => trigger.focus());
    expect(container?.querySelector(".analytics-popup--kpi")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    click(trigger);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(container?.querySelector(".analytics-popup--kpi")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("has no serious automated accessibility violations while Saved Views is expanded", async () => {
    await seedEncryptedViews(SAVED_VIEWS_SCOPE, [
        { id: "weekly", name: "Weekly check", range: "7d", vsPrevious: true },
      ]);
    render(
      <SavedViewsMenu
        current={{ range: "30d", vsPrevious: false }}
        onApply={vi.fn()}
        storageScope={SAVED_VIEWS_SCOPE}
      />,
    );
    click(ViewsTrigger());
    await waitFor(() =>
      expect(container?.textContent).toContain("Weekly check"),
    );
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("has no serious automated accessibility violations while KPI Config is expanded", async () => {
    render(<KpiHarness />);
    click(dialogTrigger("Configure KPI cards"));
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });
});
