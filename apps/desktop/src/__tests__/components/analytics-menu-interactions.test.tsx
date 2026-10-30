// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
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

import { ChartActions } from "../../components/analytics/ChartActions";
import { ExportMenu } from "../../components/analytics/ExportMenu";
import { GroupByMenu } from "../../components/analytics/GroupByMenu";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
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

function press(key: string): void {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
}

async function pressWindow(key: string, composing = false): Promise<void> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true });
  if (composing) Object.defineProperty(event, "isComposing", { value: true });
  act(() => {
    window.dispatchEvent(event);
  });
  await act(async () => Promise.resolve());
}

function menuTrigger(index = 0): HTMLButtonElement {
  const triggers = container?.querySelectorAll<HTMLButtonElement>(
    'button[aria-haspopup="menu"]',
  );
  const trigger = triggers?.[index] ?? null;
  expect(trigger).not.toBeNull();
  return trigger!;
}

describe("analytics true-menu interactions", () => {
  it("names Export, enters it, traverses it, typeaheads, and dismisses lawfully", async () => {
    render(
      <ExportMenu
        stats={null}
        campaignReports={{}}
        campaignNames={{}}
        range="30d"
      />,
    );

    const trigger = menuTrigger();
    expect(trigger.getAttribute("aria-controls")).toBeNull();
    click(trigger);

    const menu = container?.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(trigger.getAttribute("aria-controls")).toBe(menu?.id);
    expect(menu?.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(document.activeElement?.textContent).toContain("CSV snapshot");

    press("End");
    expect(document.activeElement?.textContent).toContain("Print / PDF");
    press("Home");
    expect(document.activeElement?.textContent).toContain("CSV snapshot");
    press("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Print / PDF");
    press("c");
    expect(document.activeElement?.textContent).toContain("CSV snapshot");

    await pressWindow("Escape", true);
    expect(container?.querySelector('[role="menu"]')).not.toBeNull();
    await pressWindow("Escape");
    expect(container?.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    click(trigger);
    press("Tab");
    expect(container?.querySelector('[role="menu"]')).toBeNull();

    click(trigger);
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(container?.querySelector('[role="menu"]')).toBeNull();
  });

  it("keeps unavailable Group By choices focusable, explained, and inert", async () => {
    const onChange = vi.fn();
    render(
      <GroupByMenu
        value="domain"
        unavailable={["segment", "country", "mail-client", "device"]}
        onChange={onChange}
      />,
    );
    const trigger = menuTrigger();
    click(trigger);

    expect(document.activeElement?.textContent).toContain("Domain");
    const items = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ??
        [],
    );
    press("c");
    expect(document.activeElement?.textContent).toContain("Country");
    press("c");
    expect(document.activeElement?.textContent).toContain("Campaign");
    const list = items.find((item) => item.textContent?.trim().startsWith("List"));
    expect(list).not.toBeUndefined();
    expect(list?.disabled).toBe(false);
    expect(list?.getAttribute("aria-disabled")).toBe("true");
    const reasonId = list?.getAttribute("aria-describedby") ?? "";
    expect(reasonId).not.toBe("");
    expect(document.getElementById(reasonId)?.textContent).toContain(
      "Events carry no list attribution",
    );

    act(() => list?.focus());
    click(list ?? null);
    expect(onChange).not.toHaveBeenCalled();
    expect(container?.querySelector('[role="menu"]')).not.toBeNull();

    const campaign = items.find((item) =>
      item.textContent?.trim().startsWith("Campaign"),
    );
    click(campaign ?? null);
    await act(async () => Promise.resolve());
    expect(onChange).toHaveBeenCalledWith("campaign");
    expect(container?.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("gives each Chart Actions instance unique relationships and closes on focus departure", () => {
    render(
      <>
        <ChartActions
          chartId="growth"
          chartName="Subscriber growth"
          rangeLabel="30d"
          getChartEl={() => null}
        />
        <ChartActions
          chartId="velocity"
          chartName="Engagement velocity"
          rangeLabel="30d"
          getChartEl={() => null}
        />
      </>,
    );
    const first = menuTrigger(0);
    const second = menuTrigger(1);
    expect(first.id).not.toBe(second.id);

    click(first);
    const menu = container?.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.id).toBe(first.getAttribute("aria-controls"));
    expect(menu?.getAttribute("aria-label")).toBe("Subscriber growth actions");
    expect(menu?.classList.contains("analytics-popup--chart-actions")).toBe(true);
    expect(document.activeElement?.textContent).toContain("Download PNG");
    press("c");
    expect(document.activeElement?.textContent).toContain("Copy link");

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(container?.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("has no serious automated accessibility violations with Group By expanded", async () => {
    render(
      <GroupByMenu
        value="campaign"
        unavailable={["segment", "country", "mail-client", "device"]}
        onChange={vi.fn()}
      />,
    );
    click(menuTrigger());
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });
});
