// @vitest-environment happy-dom

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

import { AuditCalendar } from "../../components/audit/AuditCalendar";
import { AuditTimeline } from "../../components/audit/AuditTimeline";
import { CampaignCalendar } from "../../components/campaigns/CampaignCalendar";
import { Heatmap } from "../../components/charts/Heatmap";
import { DashboardStatGrid } from "../../components/dashboard/DashboardStatGrid";
import type { AuditRow, Campaign } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0);
    return 1;
  };
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
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

function normalizedText(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("DUX-011 critical workflow alternatives", () => {
  it("reorders dashboard metrics with a persistent button and announces the result", () => {
    const onReorder = vi.fn();
    render(
      <DashboardStatGrid
        stats={{}}
        loading={false}
        editing
        onDrilldown={vi.fn()}
        order={["subs", "opens", "clicks", "bounces"]}
        onReorder={onReorder}
      />,
    );

    click(document.querySelector('[aria-label="Move Subscribers later"]'));

    expect(onReorder).toHaveBeenCalledWith([
      "opens",
      "subs",
      "clicks",
      "bounces",
    ]);
    expect(document.body.textContent).toContain(
      "Moved Subscribers to position 2 of 4.",
    );
    expect(
      document.querySelector('[role="list"][aria-label="Dashboard metrics"]'),
    ).not.toBeNull();
  });

  it("keeps reorder affordances out of the normal dashboard mode", () => {
    const onDrilldown = vi.fn();
    render(
      <DashboardStatGrid
        stats={{ subscribers_total: 25 }}
        loading={false}
        onDrilldown={onDrilldown}
        order={["subs", "opens", "clicks", "bounces"]}
        onReorder={vi.fn()}
      />,
    );

    expect(document.querySelector("[draggable=true]")).toBeNull();
    expect(
      document.querySelector('[aria-label^="Move Subscribers"]'),
    ).toBeNull();
    click(document.querySelector('[aria-label="Open Subscribers details"]'));
    expect(onDrilldown).toHaveBeenCalledWith("subs");
  });

  it("distinguishes unavailable metrics from confirmed zero", () => {
    render(
      <DashboardStatGrid stats={{}} loading={false} onDrilldown={vi.fn()} />,
    );
    expect(
      Array.from(document.querySelectorAll(".stat-value")).map((node) =>
        normalizedText(node),
      ),
    ).toEqual(["—", "—", "—", "—"]);
    expect(
      Array.from(document.querySelectorAll(".stat-evidence-status")).map(
        (node) => normalizedText(node),
      ),
    ).toEqual([
      "No verified delivery evidence",
      "No verified delivery evidence",
      "No verified send evidence",
    ]);
    expect(document.querySelectorAll(".dash-ask-why")).toHaveLength(3);

    act(() =>
      root?.render(
        <DashboardStatGrid
          stats={{
            subscribers_total: 0,
            unique_opens_30d: 0,
            unique_clicks_30d: 0,
            unique_bounces_30d: 0,
            unique_delivered_30d: 100,
            unique_sent_30d: 100,
          }}
          loading={false}
          onDrilldown={vi.fn()}
        />,
      ),
    );
    expect(
      Array.from(document.querySelectorAll(".stat-value")).map((node) =>
        normalizedText(node),
      ),
    ).toEqual(["0", "0.0%", "0.0%", "0.0%"]);
    expect(document.querySelectorAll(".stat-evidence-status")).toHaveLength(0);
  });

  it("renders bounded unique-recipient rates, like-for-like deltas, and no mismatched rate sparklines", () => {
    render(
      <DashboardStatGrid
        stats={{
          subscribers_total: 100,
          subscribers_added_30d: 10,
          // Gross counts and their count sparklines must not drive rate cards.
          emails_sent_30d: 1,
          opens_total_30d: 9_999,
          clicks_total_30d: 8_888,
          bounces_total_30d: 7_777,
          unique_opens_30d: 40,
          unique_clicks_30d: 10,
          unique_bounces_30d: 2,
          unique_delivered_30d: 80,
          unique_sent_30d: 100,
          previous: {
            subscribers_added: 5,
            unique_opens: 20,
            unique_clicks: 5,
            unique_bounces: 4,
            unique_delivered: 50,
            unique_sent: 100,
          },
          sparklines: {
            subscribers: [90, 95, 100],
            opens: [1, 100, 1],
            clicks: [1, 200, 1],
            bounces: [1, 300, 1],
          },
        }}
        loading={false}
        onDrilldown={vi.fn()}
      />,
    );

    expect(
      Array.from(document.querySelectorAll(".stat-value")).map((node) =>
        normalizedText(node),
      ),
    ).toEqual(["100", "50.0%", "12.5%", "2.0%"]);
    expect(
      Array.from(document.querySelectorAll(".stat-delta")).map((node) =>
        normalizedText(node),
      ),
    ).toEqual([
      "+5 vs previous period",
      "+10.0pt vs previous period",
      "+2.5pt vs previous period",
      "-2.0pt vs previous period",
    ]);
    expect(document.querySelectorAll(".dash-sparkline")).toHaveLength(1);
    expect(
      document
        .querySelector('.dash-sparkline [role="img"]')
        ?.getAttribute("aria-label"),
    ).toContain("Subscribers trend");
    expect(
      Array.from(document.querySelectorAll(".dash-ask-why")).map((node) => ({
        label: node.textContent?.trim(),
        accessibleName: node.getAttribute("aria-label"),
      })),
    ).toEqual([
      {
        label: "Explain volume",
        accessibleName: "Explain open-event volume with AI",
      },
      {
        label: "Explain volume",
        accessibleName: "Explain click-event volume with AI",
      },
      {
        label: "Explain volume",
        accessibleName: "Explain bounce-event volume with AI",
      },
    ]);
  });

  it("uses unique-sent fallback for partial delivery events and withholds impossible rates", () => {
    render(
      <DashboardStatGrid
        stats={{
          unique_opens_30d: 90,
          unique_clicks_30d: 20,
          unique_bounces_30d: 2,
          unique_delivered_30d: 10,
          unique_sent_30d: 100,
        }}
        loading={false}
        onDrilldown={vi.fn()}
      />,
    );
    expect(
      Array.from(document.querySelectorAll(".stat-value")).map((node) =>
        normalizedText(node),
      ),
    ).toEqual(["—", "90.0%", "20.0%", "2.0%"]);

    act(() =>
      root?.render(
        <DashboardStatGrid
          stats={{
            unique_opens_30d: 101,
            unique_clicks_30d: 101,
            unique_bounces_30d: 101,
            unique_delivered_30d: 50,
            unique_sent_30d: 100,
          }}
          loading={false}
          onDrilldown={vi.fn()}
        />,
      ),
    );
    expect(
      Array.from(document.querySelectorAll(".stat-value")).map((node) =>
        normalizedText(node),
      ),
    ).toEqual(["—", "—", "—", "—"]);
    expect(document.body.textContent).not.toContain("101.0%");
  });

  it("contains calendar rescheduling until the scheduler contract is release-qualified", () => {
    const onReschedule = vi.fn();
    const now = new Date();
    const currentDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const campaign = {
      id: "campaign-1",
      name: "Launch note",
      status: "scheduled",
      scheduled_at: `${currentDay}T12:00:00Z`,
    } as Campaign;
    render(
      <CampaignCalendar
        canMutate
        campaigns={[campaign]}
        statusTone={() => "var(--pw-info)"}
        onOpen={vi.fn()}
        onReschedule={onReschedule}
      />,
    );

    const reschedule = document.querySelector<HTMLButtonElement>(
      '[aria-label="Reschedule Launch note"]',
    );
    expect(reschedule?.disabled).toBe(true);
    expect(reschedule?.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.querySelector('[draggable="true"]')).toBeNull();
    expect(document.querySelector('input[type="date"]')).toBeNull();
    const grid = document.querySelector('[role="grid"]');
    expect(grid?.querySelectorAll(":scope > [role='row']")).toHaveLength(7);
    expect(
      grid?.querySelectorAll(
        ":scope > [role='columnheader'], :scope > [role='gridcell']",
      ),
    ).toHaveLength(0);
    expect(document.body.textContent).toContain("Schedule changes are paused.");
    click(reschedule);
    expect(onReschedule).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("· scheduled");
  });

  it("moves through audit calendar days with the grid keyboard pattern", () => {
    render(<AuditCalendar rows={[]} onSelectDay={vi.fn()} />);
    const active = document.querySelector<HTMLButtonElement>(
      '[data-calendar-index][tabindex="0"]',
    );
    expect(active).not.toBeNull();
    const index = Number(active?.dataset.calendarIndex);
    act(() => {
      active?.focus();
      active?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(
      (document.activeElement as HTMLElement | null)?.dataset.calendarIndex,
    ).toBe(String(index + 1));
    expect(document.body.textContent).toContain(
      "D destructive · A authentication · E export · O operations",
    );
  });

  it("inspects and activates every heatmap cell with roving Arrow keys", () => {
    const onSelectCell = vi.fn();
    render(
      <Heatmap
        rows={[
          { label: "Monday", values: [1, 2] },
          { label: "Tuesday", values: [3, 4] },
        ]}
        columns={["09:00", "10:00"]}
        metricLabel="Events by hour"
        valueLabel="Events"
        provenance={{
          source: "Test fixture",
          asOf: null,
          scope: "Unit test",
        }}
        exportFileName="events-by-hour.csv"
        exportPrivacy="personal"
        formatCell={(value) => String(value)}
        onSelectCell={onSelectCell}
      />,
    );
    const first = document.querySelector<HTMLElement>(
      '[data-heatmap-cell="0:0"]',
    );
    act(() => {
      first?.focus();
      first?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    const second = document.querySelector<HTMLElement>(
      '[data-heatmap-cell="0:1"]',
    );
    expect(document.activeElement).toBe(second);
    act(() => {
      second?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onSelectCell).toHaveBeenCalledWith(0, 1, 2);
    expect(document.querySelector('table[role="grid"]')).not.toBeNull();
  });

  it("uses one tab stop and Arrow keys to inspect the audit timeline", () => {
    const rows = [
      {
        id: 1,
        action: "subscriber.delete",
        actorType: "human",
        actorLabel: "Avery",
        at: "2026-07-01T01:00:00Z",
      },
      {
        id: 2,
        action: "user.login",
        actorType: "human",
        actorLabel: "Blake",
        at: "2026-07-01T02:00:00Z",
      },
    ] as AuditRow[];
    render(<AuditTimeline rows={rows} onSelect={vi.fn()} />);
    const first = document.querySelector<HTMLButtonElement>(
      '[data-timeline-index="0"]',
    );
    act(() => {
      first?.focus();
      first?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(
      (document.activeElement as HTMLElement | null)?.dataset.timelineIndex,
    ).toBe("1");
    expect(document.body.textContent).toContain(
      "◆ Destructive · ■ Authentication · ○ Export · ● Operations",
    );
  });
});
