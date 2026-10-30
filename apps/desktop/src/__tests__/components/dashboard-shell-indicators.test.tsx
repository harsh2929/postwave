// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeSend: {
    campaignId: "campaign-live",
    name: "Friday launch",
    openRate: 0.425,
    clickRate: 0.084,
  },
  liveSubs: { total: 12_482, added: 418, at: 1 },
  navigateDesktopSectionResource: vi.fn(),
  setSection: vi.fn(),
}));

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopSectionResource: mocks.navigateDesktopSectionResource,
}));
vi.mock("../../lib/store", () => ({
  setSection: mocks.setSection,
  useActiveSend: () => mocks.activeSend,
  useLiveSubs: () => mocks.liveSubs,
}));

import { ActiveSendStrip } from "../../components/dashboard/ActiveSendStrip";
import { LiveSubsChip } from "../../components/dashboard/LiveSubsChip";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.navigateDesktopSectionResource.mockReset();
  mocks.setSection.mockReset();
  mocks.activeSend.campaignId = "campaign-live";
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

it("opens the exact live campaign without inline presentation styles", () => {
  render(<ActiveSendStrip />);
  const trigger = button("Friday launch");

  expect(trigger.textContent).toContain("42.5% open");
  expect(trigger.textContent).toContain("8.4% click");
  expect(trigger.querySelector("[style]")).toBeNull();

  act(() => trigger.click());
  expect(mocks.navigateDesktopSectionResource).toHaveBeenCalledWith(
    "campaigns",
    "campaign-live",
  );
  expect(mocks.setSection).not.toHaveBeenCalled();
});

it("falls back safely when a sending row has no resource id", () => {
  mocks.activeSend.campaignId = "";
  render(<ActiveSendStrip />);

  act(() => button("Friday launch").click());
  expect(mocks.setSection).toHaveBeenCalledWith("campaigns");
  expect(mocks.navigateDesktopSectionResource).not.toHaveBeenCalled();
});

it("keeps the live subscriber chip concise and navigable", () => {
  render(<LiveSubsChip />);
  const trigger = button("12,482");
  expect(trigger.getAttribute("aria-label")).toContain(
    "12,482 subscribers, +418 in the current window",
  );

  act(() => trigger.click());
  expect(mocks.setSection).toHaveBeenCalledWith("dashboard");
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent?.includes(label) ||
      candidate.getAttribute("aria-label")?.includes(label),
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
