// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/pending-mutations", () => ({
  usePendingMutations: () => [
    {
      email: "pending-unconfirmed@example.test",
      tags: [],
      status: "unconfirmed",
    },
    {
      email: "pending-consented@example.test",
      tags: [],
      status: "enabled",
    },
  ],
}));

vi.mock("../../components/charts/AccessibleChartData", () => ({
  AccessibleChartData: ({ title }: { title: string }) => (
    <div data-testid="accessible-status-data">{title}</div>
  ),
}));

import { SubscribersStatStrip } from "../../components/subscribers/SubscribersStatStrip";

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
});

describe("SubscribersStatStrip", () => {
  it("keeps exact server totals separate from loaded-page status evidence", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <SubscribersStatStrip
          rows={[
            {
              id: "subscriber-1",
              email: "active@example.test",
              status: "enabled",
            },
            {
              id: "subscriber-2",
              email: "unsubscribed@example.test",
              status: "blocklisted",
            },
            {
              id: "subscriber-3",
              email: "unknown@example.test",
              status: "future_status",
            },
          ]}
          serverTotal={100}
          matchTotal={30}
          added30d={10}
          unsubbed30d={3}
        />,
      );
    });

    const cards = Array.from(
      container.querySelectorAll<HTMLElement>(".stat-card"),
    );
    expect(cards).toHaveLength(4);
    expect(cards[0]?.textContent).toContain("Workspace total");
    expect(cards[0]?.textContent).toContain("100");
    expect(cards[0]?.textContent).toContain(
      "2 local creates syncing separately",
    );
    expect(cards[1]?.textContent).toContain("Applied view");
    expect(cards[1]?.textContent).toContain("30");
    expect(cards[2]?.textContent).toContain("Net new · 30d");
    expect(cards[2]?.textContent).toContain("+7");
    expect(cards[3]?.textContent).toContain("Status evidence");
    expect(cards[3]?.textContent).toContain("5 evidenced");
    expect(cards[3]?.textContent).toContain(
      "3 server-loaded · 2 local pending",
    );
    expect(cards[3]?.textContent).toContain("not a workspace-rate sample");
    expect(container.textContent).not.toContain("Active rate");
    expect(container.textContent).not.toContain("Unsub rate");

    const result = await axe.run(container);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });
});
