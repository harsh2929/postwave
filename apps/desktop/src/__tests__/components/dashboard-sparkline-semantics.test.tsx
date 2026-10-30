// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Sparkline } from "../../components/dashboard/Sparkline";

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

function renderSparkline(
  values: readonly number[],
  tone: "good" | "bad",
): SVGElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <Sparkline values={values} tone={tone} ariaLabel="Open rate trend" />,
    ),
  );
  const chart = document.querySelector<SVGElement>('svg[role="img"]');
  if (!chart) throw new Error("Missing sparkline chart");
  return chart;
}

describe("Dashboard sparkline semantics", () => {
  it("derives an increase from geometry even when the metric tone is adverse", () => {
    const chart = renderSparkline([10, 20, 15], "bad");
    expect(chart.getAttribute("aria-label")).toContain(
      "Open rate trend: increasing across 3 points",
    );
    expect(chart.getAttribute("aria-label")).toContain(
      "starts at 10, ends at 15, minimum 10, maximum 20",
    );
  });

  it("derives a decrease from geometry even when the metric tone is positive", () => {
    const chart = renderSparkline([20, Number.NaN, 10], "good");
    expect(chart.getAttribute("aria-label")).toContain(
      "Open rate trend: decreasing across 3 points",
    );
    expect(chart.getAttribute("aria-label")).toContain("1 unavailable");
  });
});
