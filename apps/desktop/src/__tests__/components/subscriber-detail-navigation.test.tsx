// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SubscriberDetailTabId } from "../../components/subscriber-detail-types";
import type { SubscriberDetailDataController } from "../../components/subscribers/useSubscriberDetailData";
import type { SubscriberDetailMutationController } from "../../components/subscribers/useSubscriberDetailMutations";

vi.mock("../../components/subscribers/SubscriberInsightsPanel", () => ({
  SubscriberInsightsPanel: () => null,
}));
vi.mock("../../components/subscribers/SubscriberEmailHealthCard", () => ({
  SubscriberEmailHealthCard: () => null,
}));
vi.mock("../../components/subscribers/SubscriberProfilePanel", () => ({
  SubscriberProfilePanel: ({ active }: { active: boolean }) => (
    <div data-testid="profile-panel" data-active={String(active)}>
      Profile content
    </div>
  ),
}));
vi.mock("../../components/subscribers/SubscriberListsPanel", () => ({
  SubscriberListsPanel: ({ active }: { active: boolean }) => (
    <div data-testid="lists-panel" data-active={String(active)}>
      Lists content
    </div>
  ),
}));
vi.mock("../../components/subscribers/SubscriberNotesPanel", () => ({
  SubscriberNotesPanel: ({ active }: { active: boolean }) => (
    <div data-testid="notes-panel" data-active={String(active)}>
      Notes content
    </div>
  ),
}));
vi.mock("../../components/subscribers/RFMProfileCard", () => ({
  RFMProfileCard: () => <div>Predictive content</div>,
}));
vi.mock("../../components/subscriber/SubscriberCustomObjectLinks", () => ({
  SubscriberCustomObjectLinks: () => <div>Custom-object content</div>,
}));
vi.mock("../../components/subscriber/AttributeHistoryTimeline", () => ({
  AttributeHistoryTimeline: () => <div>Attribute-history content</div>,
}));
vi.mock("../../components/subscriber/PIIFindingsPanel", () => ({
  PIIFindingsPanel: () => <div>PII-findings content</div>,
}));
vi.mock("../../components/subscriber/SegmentDecisionsPanel", () => ({
  SegmentDecisionsPanel: () => <div>Segment-decisions content</div>,
}));

import { SubscriberDetailPresentation } from "../../components/subscribers/SubscriberDetailPresentation";

interface Availability {
  attrHistoryUnavailable: boolean;
  customObjectsUnavailable: boolean;
  piiFindingsUnavailable: boolean;
  decisionsUnavailable: boolean;
}

const AVAILABLE: Availability = {
  attrHistoryUnavailable: false,
  customObjectsUnavailable: false,
  piiFindingsUnavailable: false,
  decisionsUnavailable: false,
};

const OPTIONAL_UNAVAILABLE: Availability = {
  attrHistoryUnavailable: true,
  customObjectsUnavailable: true,
  piiFindingsUnavailable: true,
  decisionsUnavailable: true,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function mutationController(): SubscriberDetailMutationController {
  return {
    actionBusy: false,
    confirmDeleteOpen: false,
    setConfirmDeleteOpen: vi.fn(),
    dsarBusy: false,
    dsarModal: null,
    dsarModalNonce: 0,
    eraseConfirm: "",
    setEraseConfirm: vi.fn(),
    jurisdictionBusy: false,
    suppress: vi.fn(),
    archiveSubscriber: vi.fn(),
    unarchiveSubscriber: vi.fn(),
    exportDsar: vi.fn(),
    openDsarModal: vi.fn(),
    closeDsarModal: vi.fn(),
    reconfirmJurisdiction: vi.fn(),
  } as unknown as SubscriberDetailMutationController;
}

function dataController(
  tab: SubscriberDetailTabId,
  setTab: (next: SubscriberDetailTabId) => void,
  availability: Availability,
): SubscriberDetailDataController {
  return {
    id: "subscriber-1",
    detail: {
      id: "subscriber-1",
      email: "grace@example.test",
      status: "subscribed",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    setDetail: vi.fn(),
    loadingDetail: false,
    detailError: null,
    reloadDetail: vi.fn(),
    timeline: null,
    timelineUnavailable: true,
    setTimelineUnavailable: vi.fn(),
    timelineLoading: false,
    legacyActivity: [],
    tab,
    setTab,
    ...availability,
    setAttrHistoryUnavailable: vi.fn(),
    setCustomObjectsUnavailable: vi.fn(),
    setPiiFindingsUnavailable: vi.fn(),
    setDecisionsUnavailable: vi.fn(),
    channelMode: "email",
    setChannelMode: vi.fn(),
    crossChannelUnavailable: true,
    setCrossChannelUnavailable: vi.fn(),
    contactPerf: null,
    contactPerfState: "unavailable",
    sparkPoints: [],
    history: [],
    historyHasMore: false,
    historyLoadingMore: false,
    historyLoadMoreError: null,
    loadMoreHistory: vi.fn(),
    replaceHistory: vi.fn(),
  } as unknown as SubscriberDetailDataController;
}

function Harness({
  initialTab = "history",
  availability = OPTIONAL_UNAVAILABLE,
}: {
  initialTab?: SubscriberDetailTabId;
  availability?: Availability;
}): ReactElement {
  const [tab, setTab] = useState<SubscriberDetailTabId>(initialTab);
  return (
    <SubscriberDetailPresentation
      source={{
        subscriber: { id: "subscriber-1", email: "grace@example.test" },
        onClose: vi.fn(),
      }}
      navigation={{ enabled: false, canPrev: false, canNext: false }}
      data={dataController(tab, setTab, availability)}
      mutations={mutationController()}
      canMutate
      canAdmin
    />
  );
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function settle(): Promise<void> {
  await act(async () => Promise.resolve());
}

function tablist(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[role="tablist"][aria-label="${label}"]`,
  );
  if (!found) throw new Error(`Missing tablist ${label}`);
  return found;
}

function tabsIn(label: string): HTMLButtonElement[] {
  return Array.from(
    tablist(label).querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
}

function tab(label: string, name: string): HTMLButtonElement {
  const found = tabsIn(label).find((candidate) =>
    candidate.textContent?.startsWith(name),
  );
  if (!found) throw new Error(`Missing ${name} in ${label}`);
  return found;
}

function press(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("Subscriber detail information architecture", () => {
  it("renders a stable, axe-clean group and leaf hierarchy with honest unavailable leaves", async () => {
    render(<Harness />);
    await settle();

    expect(
      tabsIn("Subscriber detail groups").map((item) => item.textContent),
    ).toEqual(["Summary", "Activity", "Data", "Consent", "Governance"]);
    expect(
      tab("Subscriber detail groups", "Governance").getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(tabsIn("Summary sections").map((item) => item.textContent)).toEqual([
      "Profile",
      "Engagement",
      "Predictive",
    ]);
    expect(tabsIn("Activity sections").map((item) => item.textContent)).toEqual(
      ["Timeline", "Referrals"],
    );
    expect(tabsIn("Data sections").map((item) => item.textContent)).toEqual([
      "Lists & Tags",
      "Custom Objects · Unavailable",
      "Attribute History · Unavailable",
    ]);
    expect(tabsIn("Consent sections").map((item) => item.textContent)).toEqual([
      "Privacy",
      "Preferences",
    ]);
    expect(
      tabsIn("Governance sections").map((item) => item.textContent),
    ).toEqual([
      "Notes",
      "History",
      "PII Findings · Unavailable",
      "Segment Decisions · Unavailable",
    ]);
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(19);

    const customObjects = tab("Data sections", "Custom Objects");
    expect(customObjects.disabled).toBe(true);
    expect(customObjects.getAttribute("aria-disabled")).toBe("true");
    const reasonId = customObjects.getAttribute("aria-describedby");
    expect(document.getElementById(reasonId ?? "")?.textContent).toContain(
      "aren't supported by this deployment",
    );
    expect(document.activeElement).toBe(tab("Governance sections", "History"));

    const result = await axe.run(
      document.querySelector<HTMLElement>('[role="dialog"]')!,
    );
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("uses manual APG keyboard behavior, skips unavailable leaves, and remembers each group", async () => {
    render(<Harness />);
    await settle();
    const preservedProfilePanel = document.querySelector(
      '[data-testid="profile-panel"]',
    );

    const governance = tab("Subscriber detail groups", "Governance");
    act(() => governance.focus());
    expect(press(governance, "ArrowRight").defaultPrevented).toBe(true);
    const summary = tab("Subscriber detail groups", "Summary");
    expect(document.activeElement).toBe(summary);
    expect(summary.getAttribute("aria-selected")).toBe("false");
    press(summary, "Enter");
    expect(summary.getAttribute("aria-selected")).toBe("true");
    expect(
      tab("Summary sections", "Profile").getAttribute("aria-selected"),
    ).toBe("true");
    expect(document.querySelector('[data-testid="profile-panel"]')).toBe(
      preservedProfilePanel,
    );

    const profile = tab("Summary sections", "Profile");
    act(() => profile.focus());
    press(profile, "ArrowRight");
    const engagement = tab("Summary sections", "Engagement");
    expect(document.activeElement).toBe(engagement);
    expect(engagement.getAttribute("aria-selected")).toBe("false");
    press(engagement, "Enter");
    expect(engagement.getAttribute("aria-selected")).toBe("true");

    act(() => governance.click());
    expect(
      tab("Governance sections", "History").getAttribute("aria-selected"),
    ).toBe("true");
    const history = tab("Governance sections", "History");
    act(() => history.focus());
    press(history, "ArrowRight");
    expect(document.activeElement).toBe(tab("Governance sections", "Notes"));

    act(() => summary.click());
    expect(engagement.getAttribute("aria-selected")).toBe("true");
  });

  it("preserves enabled deep-link focus and stable ids when capabilities become unavailable", async () => {
    render(<Harness initialTab="customObjects" availability={AVAILABLE} />);
    await settle();
    expect(
      tab("Subscriber detail groups", "Data").getAttribute("aria-selected"),
    ).toBe("true");
    const customObjects = tab("Data sections", "Custom Objects");
    expect(customObjects.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(customObjects);
    const originalIds = tabsIn("Data sections").map((item) => item.id);

    act(() =>
      root?.render(
        <Harness
          initialTab="customObjects"
          availability={{
            ...AVAILABLE,
            customObjectsUnavailable: true,
            attrHistoryUnavailable: true,
          }}
        />,
      ),
    );
    await settle();

    expect(tabsIn("Data sections").map((item) => item.id)).toEqual(originalIds);
    expect(tab("Data sections", "Custom Objects").disabled).toBe(true);
    expect(tab("Data sections", "Attribute History").disabled).toBe(true);
    expect(
      tab("Data sections", "Lists & Tags").getAttribute("aria-selected"),
    ).toBe("true");
    expect(document.activeElement).toBe(tab("Data sections", "Lists & Tags"));

    act(() =>
      root?.render(
        <Harness initialTab="customObjects" availability={AVAILABLE} />,
      ),
    );
    await settle();
    expect(tabsIn("Data sections").map((item) => item.id)).toEqual(originalIds);
    expect(tab("Data sections", "Custom Objects").disabled).toBe(false);
    expect(
      tab("Data sections", "Lists & Tags").getAttribute("aria-selected"),
    ).toBe("true");
  });
});
