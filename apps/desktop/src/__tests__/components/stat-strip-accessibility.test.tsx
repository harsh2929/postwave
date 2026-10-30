// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { StatStrip } from "../../components/StatStrip";

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

describe("StatStrip accessibility", () => {
  it("keeps drilldown and contextual help as separate keyboard controls", async () => {
    const drillDown = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <StatStrip
          cells={[
            {
              label: "No reported use",
              value: "4",
              hint: "Usage is based on the latest verified references.",
              onClick: drillDown,
              ariaLabel: "Filter to assets with no reported use",
            },
            { label: "Visible size", value: "12 MB" },
          ]}
        />,
      ),
    );

    const action = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Filter to assets with no reported use"]',
    );
    const help = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="About No reported use:"]',
    );
    expect(action).not.toBeNull();
    expect(help).not.toBeNull();
    expect(action?.contains(help)).toBe(false);
    expect(action?.tabIndex).toBe(0);
    expect(help?.tabIndex).toBe(0);

    act(() => help?.click());
    expect(drillDown).not.toHaveBeenCalled();
    act(() => action?.click());
    expect(drillDown).toHaveBeenCalledTimes(1);

    const results = await axe.run(container, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
