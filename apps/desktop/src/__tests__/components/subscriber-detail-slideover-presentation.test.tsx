// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SubscriberDetailDataController } from "../../components/subscribers/useSubscriberDetailData";
import type { SubscriberDetailMutationController } from "../../components/subscribers/useSubscriberDetailMutations";

vi.mock("../../components/subscribers/SubscriberInsightsPanel", () => ({
  SubscriberInsightsPanel: () => null,
}));
vi.mock("../../components/subscribers/SubscriberEmailHealthCard", () => ({
  SubscriberEmailHealthCard: () => null,
}));
vi.mock("../../components/subscribers/SubscriberProfilePanel", () => ({
  SubscriberProfilePanel: () => null,
}));
vi.mock("../../components/subscribers/SubscriberListsPanel", () => ({
  SubscriberListsPanel: () => null,
}));
vi.mock("../../components/subscribers/SubscriberNotesPanel", () => ({
  SubscriberNotesPanel: () => null,
}));

import { SubscriberDetailPresentation } from "../../components/subscribers/SubscriberDetailPresentation";

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
  document.body.style.overflow = "";
});

function data(): SubscriberDetailDataController {
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
    timelineUnavailable: false,
    setTimelineUnavailable: vi.fn(),
    timelineLoading: false,
    legacyActivity: [],
    tab: "history",
    setTab: vi.fn(),
    attrHistoryUnavailable: true,
    setAttrHistoryUnavailable: vi.fn(),
    customObjectsUnavailable: true,
    setCustomObjectsUnavailable: vi.fn(),
    piiFindingsUnavailable: true,
    setPiiFindingsUnavailable: vi.fn(),
    decisionsUnavailable: true,
    setDecisionsUnavailable: vi.fn(),
    channelMode: "email",
    setChannelMode: vi.fn(),
    crossChannelUnavailable: true,
    setCrossChannelUnavailable: vi.fn(),
    contactPerf: null,
    contactPerfState: "idle",
    sparkPoints: [],
    history: [],
    historyHasMore: false,
    historyLoadingMore: false,
    historyLoadMoreError: null,
    loadMoreHistory: vi.fn(),
    replaceHistory: vi.fn(),
  } as unknown as SubscriberDetailDataController;
}

function mutations(busy = false): SubscriberDetailMutationController {
  return {
    actionBusy: busy,
    confirmSuppressOpen: false,
    setConfirmSuppressOpen: vi.fn(),
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

function Harness({ busy = false }: { busy?: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open subscriber
      </button>
      {open ? (
        <SubscriberDetailPresentation
          source={{
            subscriber: { id: "subscriber-1", email: "grace@example.test" },
            onClose: () => setOpen(false),
            navIndex: 1,
            navTotal: 3,
            onNavigate: vi.fn(),
          }}
          navigation={{ enabled: true, canPrev: true, canNext: true }}
          data={data()}
          mutations={mutations(busy)}
          canMutate
          canAdmin
        />
      ) : null}
    </>
  );
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function escape(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    }),
  );
}

function changeControl(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("SubscriberDetailPresentation slideover", () => {
  it("has one named shared shell, accessible navigation, and focus restoration", async () => {
    render(<Harness />);
    const trigger = document.querySelector<HTMLButtonElement>("button")!;
    trigger.focus();
    act(() => trigger.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(
      document.getElementById(dialog.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe("grace@example.test");
    expect(document.activeElement?.textContent).toBe("History");
    expect(dialog.querySelector("[title]")).toBeNull();
    expect(dialog.textContent).toContain("Suppress blocks all sends");
    const result = await axe.run(dialog);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    act(() => escape());
    await act(async () => Promise.resolve());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("locks every dismissal path while a subscriber operation is busy", () => {
    render(<Harness busy />);
    act(() => document.querySelector<HTMLButtonElement>("button")?.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(
      document.querySelector<HTMLButtonElement>(".slideover-close")?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Previous subscriber (Left Arrow)"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Next subscriber (Right Arrow)"]',
      )?.disabled,
    ).toBe(true);
    act(() => {
      document
        .querySelector<HTMLElement>(".slideover-overlay")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      escape();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("states the read-only access and Moosewave-only erasure scopes explicitly", () => {
    const privacyData = data();
    privacyData.tab = "privacy";
    const privacyMutations = mutations();
    render(
      <SubscriberDetailPresentation
        source={{
          subscriber: { id: "subscriber-1", email: "grace@example.test" },
          onClose: vi.fn(),
        }}
        navigation={{ enabled: false, canPrev: false, canNext: false }}
        data={privacyData}
        mutations={privacyMutations}
        canMutate
        canAdmin
      />,
    );

    expect(document.body.textContent).toContain(
      "This is read-only: provider auto-delete policies are ignored",
    );
    expect(document.body.textContent).toContain(
      "Connected commerce stores are not changed by this action",
    );
    expect(document.body.textContent).toContain(
      "Permanently erase Moosewave data",
    );
    expect(document.body.textContent).not.toContain(
      "Permanently delete from all systems",
    );
    expect(document.body.textContent).not.toContain("ISO 27560");
    expect(document.body.textContent).not.toContain("Kantara CR");
    expect(document.body.textContent).not.toContain("full consent history");
    expect(document.body.textContent).not.toContain("Export Consent Receipt");
    expect("exportConsentReceipt" in privacyMutations).toBe(false);

    const accessButton = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) =>
      candidate.textContent?.includes("Export this subscriber's data"),
    );
    act(() => accessButton?.click());
    expect(privacyMutations.openDsarModal).toHaveBeenCalledWith("access");
  });

  it("requires explicit confirmation before suppressing a subscriber", () => {
    const subscriberData = data();
    const subscriberMutations = mutations();
    render(
      <SubscriberDetailPresentation
        source={{
          subscriber: { id: "subscriber-1", email: "grace@example.test" },
          onClose: vi.fn(),
        }}
        navigation={{ enabled: false, canPrev: false, canNext: false }}
        data={subscriberData}
        mutations={subscriberMutations}
        canMutate
        canAdmin
      />,
    );

    const suppress = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Suppress");
    act(() => suppress?.click());
    expect(subscriberMutations.setConfirmSuppressOpen).toHaveBeenCalledWith(
      true,
    );
    expect(subscriberMutations.suppress).not.toHaveBeenCalled();

    act(() => root?.unmount());
    root = null;
    subscriberMutations.confirmSuppressOpen = true;
    render(
      <SubscriberDetailPresentation
        source={{
          subscriber: { id: "subscriber-1", email: "grace@example.test" },
          onClose: vi.fn(),
        }}
        navigation={{ enabled: false, canPrev: false, canNext: false }}
        data={subscriberData}
        mutations={subscriberMutations}
        canMutate
        canAdmin
      />,
    );
    expect(document.body.textContent).toContain("Suppress this subscriber?");
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Suppress subscriber");
    act(() => confirm?.click());
    expect(subscriberMutations.suppress).toHaveBeenCalledTimes(1);
  });

  it("routes an inactive detail through the reviewed exact-address enable dialog", () => {
    const inactive = data();
    inactive.detail = {
      ...inactive.detail,
      status: "disabled",
      country: "GB",
      version: `"subscriber:subscriber-1:v1"`,
    };
    render(
      <SubscriberDetailPresentation
        source={{
          subscriber: { id: "subscriber-1", email: "grace@example.test" },
          onClose: vi.fn(),
        }}
        navigation={{ enabled: false, canPrev: false, canNext: false }}
        data={inactive}
        mutations={mutations()}
        canMutate
        canAdmin
      />,
    );

    const review = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Review consent & enable");
    act(() => review?.click());
    const consentDialog = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    );
    expect(consentDialog?.textContent).toContain(
      "This creates a new email-marketing grant for grace@example.test",
    );
    expect(consentDialog?.textContent).toContain("Email marketing only");
    expect(consentDialog?.textContent).toContain(
      "does not clear independent bounce",
    );
    expect(
      consentDialog?.querySelector<HTMLInputElement>('[id$="-jurisdiction"]')
        ?.value,
    ).toBe("GB");
  });

  it("does not turn malformed metrics into plausible zeroes", () => {
    const malformed = data();
    malformed.timeline = {
      subscriber_id: "subscriber-1",
      email: "grace@example.test",
      events: [],
      pagination: { limit: 50, has_more: false },
      stats: {
        sent_count: -1,
        opened_count: Number.NaN,
        clicked_count: 4,
        bounced_count: 0,
        replied_count: 0,
        open_rate: Number.NaN,
        click_rate: 4,
        engagement_score: Number.NaN,
        subscribed_at: "2026-01-01T00:00:00.000Z",
        current_status: "unsubscribed",
      },
    };
    render(
      <SubscriberDetailPresentation
        source={{
          subscriber: { id: "subscriber-1", email: "grace@example.test" },
          onClose: vi.fn(),
        }}
        navigation={{ enabled: false, canPrev: false, canNext: false }}
        data={malformed}
        mutations={mutations()}
        canMutate
        canAdmin
      />,
    );

    expect(document.body.textContent).toContain("Profile added");
    expect(document.body.textContent).toContain("EngagementUnavailable");
    expect(document.body.textContent).toContain("OpenedUnavailableUnavailable");
    expect(document.body.textContent).not.toContain("OpenedNaN");
    expect(document.body.textContent).not.toContain("400%");
  });

  it("records complete jurisdiction evidence with the raw server CAS timestamp", () => {
    const jurisdictionData = data();
    jurisdictionData.detail = {
      ...jurisdictionData.detail,
      detected_jurisdiction: "CA",
      region: "QC",
      jurisdiction_reconfirm_required: true,
      jurisdiction_changed_at: "2026-07-18T10:00:00.123456Z",
      version: '"subscriber:subscriber-1:v17"',
    };
    const jurisdictionMutations = mutations();
    render(
      <SubscriberDetailPresentation
        source={{
          subscriber: { id: "subscriber-1", email: "grace@example.test" },
          onClose: vi.fn(),
        }}
        navigation={{ enabled: false, canPrev: false, canNext: false }}
        data={jurisdictionData}
        mutations={jurisdictionMutations}
        canMutate
        canAdmin
      />,
    );

    const start = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Record subject acceptance");
    act(() => start?.click());
    expect(document.body.textContent).toContain("Quebec Law 25");
    expect(document.body.textContent).toContain(
      "does not let an operator consent on their behalf",
    );

    const policy = Array.from(document.querySelectorAll("input")).find(
      (input) => input.type === "text",
    ) as HTMLInputElement | undefined;
    const disclosure = document.querySelector<HTMLTextAreaElement>("textarea");
    const evidence = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!policy || !disclosure || !evidence)
      throw new Error("Expected jurisdiction evidence controls");
    changeControl(policy, "privacy-2026-07");
    changeControl(
      disclosure,
      "I agree to receive email marketing under the stated privacy policy.",
    );
    act(() => evidence.click());

    const submit = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Record accepted decision");
    expect(submit?.disabled).toBe(false);
    act(() => submit?.click());
    expect(jurisdictionMutations.reconfirmJurisdiction).toHaveBeenCalledWith({
      decision: "accepted",
      regime: "law25",
      privacy_policy_version: "privacy-2026-07",
      captured_text:
        "I agree to receive email marketing under the stated privacy policy.",
      expected_jurisdiction_changed_at: "2026-07-18T10:00:00.123456Z",
      expected_subscriber_version: '"subscriber:subscriber-1:v17"',
    });
  });

  it("keeps jurisdiction evidence controls unavailable without an exact reviewed subscriber revision", () => {
    const jurisdictionData = data();
    jurisdictionData.detail = {
      ...jurisdictionData.detail,
      detected_jurisdiction: "DE",
      jurisdiction_reconfirm_required: true,
      jurisdiction_changed_at: "2026-07-18T10:00:00.123456Z",
      version: 'W/"subscriber:subscriber-1:v17"',
    };
    const jurisdictionMutations = mutations();
    render(
      <SubscriberDetailPresentation
        source={{
          subscriber: { id: "subscriber-1", email: "grace@example.test" },
          onClose: vi.fn(),
        }}
        navigation={{ enabled: false, canPrev: false, canNext: false }}
        data={jurisdictionData}
        mutations={jurisdictionMutations}
        canMutate
        canAdmin
      />,
    );

    expect(document.body.textContent).toContain(
      "The exact subscriber revision is missing or invalid",
    );
    expect(document.querySelector("textarea")).toBeNull();
    expect(jurisdictionMutations.reconfirmJurisdiction).not.toHaveBeenCalled();
  });
});
