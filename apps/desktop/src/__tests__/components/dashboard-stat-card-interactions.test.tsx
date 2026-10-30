// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../components/Icon", () => ({
  Icon: ({ name }: { name: string }) => <span aria-hidden="true">{name}</span>,
}));
vi.mock("../../components/dashboard/Sparkline", () => ({
  Sparkline: () => <span>Trend</span>,
}));

import { StatCard } from "../../components/dashboard/StatCard";

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

function buttonByLabel(label: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!match) throw new Error(`Missing ${label} button`);
  return match;
}

describe("StatCard interactions", () => {
  it("keeps reorder limits focusable and anomaly reasoning visible", async () => {
    const onOpen = vi.fn();
    const onMoveLater = vi.fn();
    const onAskWhy = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <div role="list">
          <StatCard
            label="Open rate"
            value="42%"
            anomaly
            anomalyReason="Open rate rose 18% above its trailing baseline."
            draggable
            cardKey="opens"
            reorderPosition={1}
            reorderTotal={3}
            onMoveLater={onMoveLater}
            onClick={onOpen}
            onAskWhy={onAskWhy}
          />
        </div>,
      ),
    );

    expect(document.body.textContent).toContain("Drag or use arrows");
    expect(document.body.textContent).toContain(
      "Open rate rose 18% above its trailing baseline.",
    );
    expect(document.querySelector("[title]")).toBeNull();
    const listitem = document.querySelector('[role="listitem"]');
    expect(
      document.getElementById(listitem?.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("position 1 of 3");

    const earlier = buttonByLabel("Move Open rate earlier");
    expect(earlier.disabled).toBe(true);
    expect(earlier.hasAttribute("aria-disabled")).toBe(false);
    earlier.focus();
    expect(document.activeElement).not.toBe(earlier);
    act(() => earlier.click());
    expect(onMoveLater).not.toHaveBeenCalled();

    act(() => buttonByLabel("Move Open rate later").click());
    expect(onMoveLater).toHaveBeenCalledTimes(1);
    act(() => buttonByLabel("Open Open rate details").click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => buttonByLabel("Ask why — explain Open rate with AI").click());
    expect(onAskWhy).toHaveBeenCalledTimes(1);

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("colours a decreasing bounce rate as an improvement", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <div role="list">
          <StatCard
            label="Bounce rate"
            value="0.6%"
            delta={{ dir: "down", text: "-0.2pt" }}
            comparisonLabel="vs previous 30d"
            preferredDirection="decrease"
          />
        </div>,
      ),
    );

    const delta = document.querySelector(".stat-delta");
    expect(delta?.classList.contains("is-positive")).toBe(true);
    expect(delta?.classList.contains("is-negative")).toBe(false);
    expect(delta?.textContent).toContain("vs previous 30d");
  });
});
