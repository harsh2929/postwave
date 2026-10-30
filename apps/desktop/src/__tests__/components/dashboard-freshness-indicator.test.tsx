// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { StaleIndicator } from "../../components/dashboard/StaleIndicator";
import type { DashboardRange } from "../../lib/api-client";
import type { SseStatus } from "../../lib/sse";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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
});

function render(
  status: SseStatus,
  lastSuccessAt = 0,
  now = 70_000,
  range: DashboardRange = "30d",
  offline = false,
): void {
  const node: ReactElement = (
    <StaleIndicator
      range={range}
      liveStatus={status}
      offline={offline}
      lastSuccessAt={lastSuccessAt}
      now={now}
    />
  );
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

describe("Dashboard data freshness indicator", () => {
  it("separates a healthy connection from the last confirmed receipt", async () => {
    render("open", 68_000, 70_000);
    expect(document.body.textContent).toContain("Live updates on");
    expect(document.body.textContent).toContain("Updated just now");
    expect(document.querySelector("[title]")).toBeNull();

    render("open", 5_000, 70_000);
    expect(document.body.textContent).toContain("Updated 1m ago");
    expect(document.body.textContent).not.toContain("stale");

    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it.each([
    ["connecting", "Connecting…Polling every 5s"],
    ["reconnecting", "Reconnecting…Polling every 5s"],
    ["closed", "Polling every 5s"],
  ] as const)("renders the truthful %s fallback", (status, label) => {
    render(status);
    expect(document.body.textContent).toContain(label);
  });

  it.each(["7d", "90d"] as const)(
    "never labels the %s reporting window live",
    (range) => {
      render("open", 68_000, 70_000, range);
      expect(document.body.textContent).toContain("Polling every 5s");
      expect(document.body.textContent).toContain("Updated just now");
      expect(document.body.textContent).not.toContain("Live updates on");
      expect(
        document.querySelector("[aria-label]")?.getAttribute("aria-label"),
      ).toContain("poll every 5 seconds");
      expect(
        document.querySelector("[aria-label]")?.getAttribute("aria-label"),
      ).toContain("Updated just now");
    },
  );

  it("does not invent a receipt age before the first confirmed response", () => {
    render("open");
    expect(document.body.textContent).toContain("Live updates on");
    expect(document.body.textContent).not.toContain("Updated");
  });

  it("reports an offline retained-data state without claiming to poll or stream", () => {
    render("open", 5_000, 70_000, "30d", true);

    expect(document.body.textContent).toContain(
      "Offline · Last confirmed data",
    );
    expect(document.body.textContent).toContain("Updated 1m ago");
    expect(document.body.textContent).not.toContain("Live updates on");
    expect(document.body.textContent).not.toContain("Polling every 5s");
    expect(
      document.querySelector("[aria-label]")?.getAttribute("aria-label"),
    ).toContain("Last confirmed metrics updated 1m ago");
  });

  it("does not fabricate retained data while offline before the first receipt", () => {
    render("closed", 0, 70_000, "30d", true);

    expect(document.body.textContent).toContain("Offline · No confirmed data");
    expect(document.body.textContent).not.toContain("Updated");
    expect(
      document.querySelector("[aria-label]")?.getAttribute("aria-label"),
    ).toContain("No confirmed metrics received");
  });
});
