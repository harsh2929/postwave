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

const mocks = vi.hoisted(() => ({
  navigateDesktopRoute: vi.fn(),
  setSection: vi.fn(),
}));

vi.mock("../../lib/store", () => ({ setSection: mocks.setSection }));
vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopRoute: mocks.navigateDesktopRoute,
}));

import { InboxHealthCard } from "../../components/dashboard/InboxHealthCard";
import { StepDone } from "../../components/onboarding/StepDone";
import type { DashboardStatsResponse } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.navigateDesktopRoute.mockReset();
  mocks.setSection.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("Dashboard contextual navigation", () => {
  it("routes unknown and verified health states without inventing domain setup", () => {
    const view = render(<InboxHealthCard stats={null} />);
    act(() => button("Review deliverability").click());
    expect(mocks.setSection).toHaveBeenLastCalledWith("deliverabilityHub");

    view.rerender(<InboxHealthCard stats={{}} />);
    expect(document.body.textContent).toContain(
      "No recent inbox-health snapshot",
    );
    act(() => button("Review deliverability").click());
    expect(mocks.setSection).toHaveBeenLastCalledWith("deliverabilityHub");

    view.rerender(
      <InboxHealthCard
        stats={
          {
            inbox_health: { score: 92, state: "healthy" },
          } as DashboardStatsResponse
        }
      />,
    );
    act(() => button("Open report").click());
    expect(mocks.setSection).toHaveBeenLastCalledWith("deliverabilityHub");
  });

  it("opens exact, implemented post-onboarding Settings destinations", () => {
    render(<StepDone onClose={vi.fn()} />);
    act(() => button("Connect Slack for approvals").click());
    expect(mocks.navigateDesktopRoute).toHaveBeenLastCalledWith({
      section: "settings",
      settingsAnchor: "slack",
    });
    act(() => button("Protect your account").click());
    expect(mocks.navigateDesktopRoute).toHaveBeenLastCalledWith({
      section: "settings",
      settingsAnchor: "security",
    });
    expect(document.body.textContent).not.toContain("Invite teammates");
  });
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return { rerender: (next) => act(() => root?.render(next)) };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
