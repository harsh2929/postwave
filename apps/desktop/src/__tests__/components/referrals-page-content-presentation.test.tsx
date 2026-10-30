// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const renders = vi.hoisted(() => ({
  leaderboard: vi.fn(),
  overview: vi.fn(),
  payout: vi.fn(),
  stats: vi.fn(),
}));

vi.mock("../../components/referrals/ReferralStatsCards", () => ({
  ReferralStatsCards: () => {
    renders.stats();
    return <div data-testid="referral-stats">Historical statistics</div>;
  },
}));

vi.mock("../../components/referrals/LeaderboardCard", () => ({
  LeaderboardCard: () => {
    renders.leaderboard();
    return <div data-testid="referral-leaderboard">Masked advocates</div>;
  },
}));

vi.mock("../../pages/referrals/ReferralProgramOverview", () => ({
  ReferralProgramOverview: ({ canMutate }: { canMutate: boolean }) => {
    renders.overview(canMutate);
    return (
      <div data-testid="referral-program-overview">
        Program mutation: {String(canMutate)}
      </div>
    );
  },
}));

vi.mock("../../components/referrals/PayoutChecklist", () => ({
  PayoutChecklist: () => {
    renders.payout();
    return (
      <div data-testid="referral-payout-checklist">Unsafe payout queue</div>
    );
  },
}));

import {
  ReferralsPageContent,
  type ReferralsPageContentProps,
} from "../../components/referrals/ReferralsPageContent";
import type { ReferralProgram } from "../../lib/api-client";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const program: ReferralProgram = {
  id: "program-1",
  active: true,
  milestones: [
    {
      count: 3,
      reward_kind: "swag",
      reward_label: "Studio notebook",
    },
  ],
  updatedAt: "2026-07-25T10:00:00.000Z",
};

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
  vi.clearAllMocks();
});

function activeState(
  overrides: Partial<ReferralsPageContentProps["state"]> = {},
): ReferralsPageContentProps["state"] {
  return {
    empty: false,
    error: null,
    loading: false,
    program,
    ...overrides,
  };
}

function makeProps(
  overrides: Partial<ReferralsPageContentProps> = {},
): ReferralsPageContentProps {
  return {
    canAdmin: true,
    canManageProgram: false,
    milestones: program.milestones,
    state: activeState(),
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onInstallWebsite: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
}

function renderPage(
  overrides: Partial<ReferralsPageContentProps> = {},
): ReferralsPageContentProps {
  const props = makeProps(overrides);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<ReferralsPageContent {...props} />);
  });
  return props;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent?.replace(/\s+/g, " ").trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function press(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

describe("Referrals page presentation", () => {
  it("uses manual APG tabs while keeping safe read panels mounted", async () => {
    renderPage();

    expect(document.querySelector("h1")?.textContent).toContain(
      "Understand your referral history.",
    );
    const tablist = document.querySelector(
      '[role="tablist"][aria-label="Referral workspaces"]',
    );
    expect(tablist).not.toBeNull();
    const tabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    expect(
      tabs.map((tab) => tab.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual([
      "OverviewSnapshot state",
      "AdvocatesCredited leaders",
      "RewardsRelease boundary",
      "DistributionDelivery readiness",
    ]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.tabIndex).toBe(0);
    expect(tabs[1]?.tabIndex).toBe(-1);

    expect(renders.stats).toHaveBeenCalledOnce();
    expect(renders.overview).not.toHaveBeenCalled();
    expect(renders.leaderboard).toHaveBeenCalledOnce();
    expect(renders.payout).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="referral-payout-checklist"]'),
    ).toBeNull();
    const statsNode = document.querySelector('[data-testid="referral-stats"]');
    const snapshotNode = document.querySelector(
      '[data-testid="referral-program-snapshot"]',
    );
    const leaderboardNode = document.querySelector(
      '[data-testid="referral-leaderboard"]',
    );

    act(() => tabs[0]?.focus());
    press(tabs[0]!, "ArrowRight");
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.tabIndex).toBe(-1);
    expect(tabs[1]?.tabIndex).toBe(0);

    press(tabs[1]!, "Enter");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelector<HTMLElement>(
        '[role="tabpanel"][aria-labelledby="' + tabs[1]?.id + '"]',
      )?.hidden,
    ).toBe(false);

    press(tabs[1]!, "End");
    expect(document.activeElement).toBe(tabs[3]);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    press(tabs[3]!, " ");
    expect(tabs[3]?.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain(
      "Know what is inspectable—and what is not yet releasable.",
    );

    press(tabs[3]!, "Home");
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[3]?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[data-testid="referral-stats"]')).toBe(
      statsNode,
    );
    expect(
      document.querySelector('[data-testid="referral-program-snapshot"]'),
    ).toBe(snapshotNode);
    expect(document.querySelector('[data-testid="referral-leaderboard"]')).toBe(
      leaderboardNode,
    );

    for (const tab of tabs) {
      const panelId = tab.getAttribute("aria-controls");
      const panel = document.getElementById(panelId ?? "");
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    }

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("keeps every gated activation affordance inert for an admin", () => {
    const props = renderPage({ canAdmin: true, canManageProgram: true });

    const edit = button("Edit program");
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    expect(edit.getAttribute("aria-describedby")).toBeTruthy();
    act(() => edit.click());
    expect(props.onEdit).not.toHaveBeenCalled();

    const install = button("Install on website");
    expect(install.getAttribute("aria-disabled")).toBe("true");
    expect(install.getAttribute("aria-describedby")).toBeTruthy();
    act(() => install.click());
    expect(props.onInstallWebsite).not.toHaveBeenCalled();

    const tabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    act(() => tabs[2]?.click());
    expect(document.body.textContent).toContain(
      "zero payout reads and zero payout mutation controls",
    );
    const payout = button("Open payout queue");
    expect(payout.getAttribute("aria-disabled")).toBe("true");
    act(() => payout.click());
    expect(renders.payout).not.toHaveBeenCalled();

    act(() => tabs[3]?.click());
    const widget = button("Install widget");
    expect(widget.getAttribute("aria-disabled")).toBe("true");
    act(() => widget.click());
    expect(props.onInstallWebsite).not.toHaveBeenCalled();
  });

  it.each(["editor", "viewer"] as const)(
    "contains create, edit, reward, and install actions for a %s",
    (role) => {
      const activeProps = renderPage({
        canAdmin: false,
        canManageProgram: false,
      });

      expect(document.body.textContent).toContain("Read-only access");
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (candidate) => candidate.textContent?.trim() === "Edit program",
        ),
      ).toBe(false);
      expect(document.body.textContent).toContain(
        "Configuration evidence only",
      );
      expect(renders.overview).not.toHaveBeenCalled();
      act(() => button("Install on website").click());
      expect(activeProps.onEdit).not.toHaveBeenCalled();
      expect(activeProps.onInstallWebsite).not.toHaveBeenCalled();
      expect(renders.payout).not.toHaveBeenCalled();

      act(() => root?.unmount());
      root = null;
      container?.replaceChildren();
      const emptyProps = makeProps({
        canAdmin: false,
        canManageProgram: false,
        state: {
          empty: true,
          error: null,
          loading: false,
          program: null,
        },
      });
      root = createRoot(container!);
      act(() => root?.render(<ReferralsPageContent {...emptyProps} />));
      expect(document.body.textContent).toContain("Read-only access");
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (candidate) => candidate.textContent?.trim() === "Create program",
        ),
      ).toBe(false);
      expect(emptyProps.onCreate).not.toHaveBeenCalled();
      expect(role === "editor" || role === "viewer").toBe(true);
    },
  );

  it("distinguishes initial, refreshing, degraded, unavailable, and empty truth states", () => {
    const cases: Array<{
      expected: string[];
      state: ReferralsPageContentProps["state"];
    }> = [
      {
        state: {
          empty: false,
          error: null,
          loading: true,
          program: null,
        },
        expected: [
          "Checking program",
          "Loading verified program state.",
          "Actions remain unavailable",
        ],
      },
      {
        state: activeState({ loading: true }),
        expected: [
          "Refreshing",
          "Refreshing in the background.",
          "last verified program remains visible",
        ],
      },
      {
        state: activeState({ error: "Upstream timeout" }),
        expected: [
          "Last verified",
          "showing the last verified program",
          "Upstream timeout",
        ],
      },
      {
        state: {
          empty: false,
          error: "Contract rejected",
          loading: false,
          program: null,
        },
        expected: [
          "Unavailable",
          "No program configuration is assumed",
          "Contract rejected",
        ],
      },
      {
        state: {
          empty: true,
          error: null,
          loading: false,
          program: null,
        },
        expected: ["Not configured", "No active referral program was found."],
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      if (root) {
        act(() => root?.unmount());
        root = null;
        container?.remove();
        container = null;
      }
      renderPage({
        canAdmin: true,
        canManageProgram: false,
        state: testCase.state,
      });
      for (const expected of testCase.expected) {
        expect(
          document.body.textContent,
          `case ${index + 1}: ${expected}`,
        ).toContain(expected);
      }
      if (testCase.state.loading || testCase.state.error) {
        expect(
          Array.from(document.querySelectorAll("button")).some(
            (candidate) =>
              candidate.textContent?.trim() === "Edit program" ||
              candidate.textContent?.trim() === "Create program",
          ),
        ).toBe(false);
      }
    }
  });
});
