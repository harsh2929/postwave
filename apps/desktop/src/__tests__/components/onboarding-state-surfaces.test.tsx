// @vitest-environment happy-dom

import axe from "axe-core";
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
  blocked: false,
  openSurface: vi.fn(),
  setStep: vi.fn(),
  completeStep: vi.fn(),
  skipStep: vi.fn(),
  completeSurface: vi.fn(),
  skipSurface: vi.fn(),
  dismissSurface: vi.fn(),
  resetSurface: vi.fn(),
  navigate: vi.fn(),
  tourRecord: {
    outcome: "not-started",
    currentStepId: null as string | null,
    completedStepIds: [] as string[],
    skippedStepIds: [] as string[],
    run: 0,
    openedAt: null as number | null,
    updatedAt: 0,
  },
}));

vi.mock("../../hooks/useDesktopShortcut", () => ({
  useDesktopShortcut: (id: string) => ({
    id,
    label: "Ctrl+Shift+O",
    ariaKeyShortcuts: "Control+Shift+O",
  }),
}));

vi.mock("../../hooks/useOnboardingDialogBehavior", () => ({
  useOnboardingDialogBehavior: () => ({ isTop: true }),
}));

vi.mock("../../hooks/useOnboardingState", () => ({
  acknowledgeOnboardingWizardRestart: vi.fn(),
  useOnboardingWizardRestartRequest: () => 0,
  useOnboardingUiBlockers: () => ({
    blocked: mocks.blocked,
    topDialogId: null,
    lifecycleReview: false,
    criticalError: false,
    documentHidden: false,
  }),
  useOnboardingState: () => ({
    ready: true,
    role: "admin",
    // This suite renders the surfaces themselves, so it stands in for a session
    // whose cross-device decisions have already been consulted — the tour
    // refuses to render while that answer is still unknown, which is the whole
    // point of the gate and not what these tests are about.
    decisionsSettled: true,
    state: {
      version: 3,
      scopeToken: "scope",
      revision: 1,
      updatedAt: 1,
      goals: {
        completedStepIds: [],
        fetchedAt: 1,
        updatedAt: 1,
      },
      surfaces: {
        wizard: {
          outcome: "in-progress",
          currentStepId: "domain",
          completedStepIds: [],
          skippedStepIds: [],
          run: 1,
          openedAt: 1,
          updatedAt: 1,
        },
        checklist: {
          outcome: "not-started",
          currentStepId: null,
          completedStepIds: [],
          skippedStepIds: [],
          run: 0,
          openedAt: null,
          updatedAt: 0,
        },
        tour: mocks.tourRecord,
        catalog: {
          outcome: "in-progress",
          currentStepId: "lists",
          completedStepIds: [],
          skippedStepIds: [],
          run: 1,
          openedAt: 1,
          updatedAt: 1,
        },
      },
    },
    stepsFor: (surface: string) =>
      surface === "wizard"
        ? [
            { id: "domain" },
            { id: "subscribers" },
            { id: "campaign" },
            { id: "done" },
          ]
        : [],
    openSurface: mocks.openSurface,
    setStep: mocks.setStep,
    completeStep: mocks.completeStep,
    skipStep: mocks.skipStep,
    completeSurface: mocks.completeSurface,
    skipSurface: mocks.skipSurface,
    dismissSurface: mocks.dismissSurface,
    resetSurface: mocks.resetSurface,
  }),
}));

vi.mock("../../hooks/useOnboardingProgress", () => ({
  useOnboardingProgress: () => ({
    steps: [
      { id: "verify-domain", status: "active" },
      { id: "import-subscribers", status: "pending" },
      { id: "send-first-campaign", status: "pending" },
    ],
    completion: 0,
    ratio: { done: 0, total: 5 },
    done: false,
    dismissed: false,
    applicable: true,
    available: true,
    loading: false,
    liveConfirmed: true,
    completedStepIds: [],
  }),
}));

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopRoute: mocks.navigate,
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: (props: {
    open: boolean;
    title: string;
    onConfirm: () => void;
  }) =>
    props.open ? (
      <button type="button" onClick={props.onConfirm}>
        Confirm {props.title}
      </button>
    ) : null,
}));

vi.mock("../../components/onboarding/StepDomain", () => ({
  StepDomain: () => <div>Domain step body</div>,
}));
vi.mock("../../components/onboarding/StepSubscribers", () => ({
  StepSubscribers: () => <div>Subscriber step body</div>,
}));
vi.mock("../../components/onboarding/StepCampaign", () => ({
  StepCampaign: () => <div>Campaign step body</div>,
}));
vi.mock("../../components/onboarding/StepDone", () => ({
  StepDone: () => <div>Done step body</div>,
}));

import {
  OnboardingTour,
  OnboardingWizard,
} from "../../components/OnboardingWizard";
import { TourProvider } from "../../components/tour/TourProvider";
import { TourTooltip } from "../../components/tour/TourTooltip";
import { popDialog, pushDialog } from "../../lib/dialogStack";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.blocked = false;
  Object.assign(mocks.tourRecord, {
    outcome: "not-started",
    currentStepId: null,
    completedStepIds: [],
    skippedStepIds: [],
    run: 0,
    openedAt: null,
    updatedAt: 0,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error("Missing button: " + label);
  return found;
}

describe("DUX-034 rendered onboarding surfaces", () => {
  it("renders accessible resumable wizard progress and explicitly skips", () => {
    const view = render(<OnboardingWizard />);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Step 1 of 4");
    expect(
      document
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("0");

    act(() => button("Skip").click());
    act(() => button("Confirm Skip setup for now?").click());
    expect(mocks.skipSurface).toHaveBeenCalledWith("wizard", "domain", 0);

    mocks.blocked = true;
    view.rerender(<OnboardingWizard />);
    expect(
      (document.querySelector(".onboarding-backdrop") as HTMLElement).hidden,
    ).toBe(true);
  });

  it("routes the quick-tour catalog through the canonical router", () => {
    const onClose = vi.fn();
    render(<OnboardingTour onClose={onClose} />);
    const audience = document.querySelector<HTMLButtonElement>(
      '[aria-label="Audience: Lists, Tags, Suppressions — open this section"]',
    );
    if (!audience) throw new Error("Missing catalog audience route");
    act(() => audience.click());
    expect(mocks.completeStep).toHaveBeenCalledWith("catalog", "lists");
    expect(mocks.completeSurface).toHaveBeenCalledWith("catalog");
    expect(mocks.navigate).toHaveBeenCalledWith({ section: "lists" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the final centered tour step modal, explicit, focus-contained, motion-safe, and axe-clean", async () => {
    const onComplete = vi.fn();
    render(
      <TourTooltip
        step={{
          id: "done",
          targetSelector: null,
          title: "Tour complete",
          body: "Review this at your pace.",
          isFinal: true,
        }}
        stepIndex={9}
        totalSteps={10}
        rect={null}
        target={null}
        targetUnavailable={false}
        ownerId="test:final-tour-tooltip"
        onNext={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
        onComplete={onComplete}
      />,
    );
    expect(document.body.textContent).toContain("Tour step 10 of 10");
    expect(document.querySelector(".tour-confetti")).toBeNull();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Done");
    const result = await axe.run(dialog);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    expect(onComplete).not.toHaveBeenCalled();

    act(() => {
      button("Done").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe("Skip");
  });

  it("measures, clamps, and axe-checks an anchored non-modal step while scoping focus to the card and highlighted target", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 768,
    });
    const visualViewport = Object.assign(new EventTarget(), {
      height: 768,
      offsetLeft: 0,
      offsetTop: 0,
      width: 1024,
    });
    vi.stubGlobal("visualViewport", visualViewport);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(280);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
    const target = document.createElement("button");
    target.type = "button";
    target.textContent = "Highlighted task";
    document.body.appendChild(target);
    const onSkip = vi.fn();
    render(
      <TourTooltip
        step={{
          id: "subscribers-page",
          targetSelector: "subscriber-list",
          title: "Subscriber list",
          body: "Review the audience before sending.",
          placement: "bottom",
        }}
        stepIndex={1}
        totalSteps={3}
        rect={new DOMRect(940, 720, 80, 40)}
        target={target}
        targetUnavailable={false}
        ownerId="test:anchored-tour-tooltip"
        onNext={vi.fn()}
        onBack={vi.fn()}
        onSkip={onSkip}
        onComplete={vi.fn()}
      />,
    );

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expect(dialog.style.visibility).not.toBe("hidden");
    const left = Number.parseFloat(dialog.style.left);
    const top = Number.parseFloat(dialog.style.top);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left + 280).toBeLessThanOrEqual(1016);
    expect(top + 160).toBeLessThanOrEqual(760);
    Object.assign(visualViewport, { height: 320, width: 360 });
    act(() => {
      visualViewport.dispatchEvent(new Event("resize"));
    });
    const zoomedLeft = Number.parseFloat(dialog.style.left);
    const zoomedTop = Number.parseFloat(dialog.style.top);
    expect(zoomedLeft + 280).toBeLessThanOrEqual(352);
    expect(zoomedTop + 160).toBeLessThanOrEqual(312);
    const result = await axe.run(dialog);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    act(() => {
      button("Next").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(target);
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe("Skip");

    const composing = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(composing, "isComposing", { value: true });
    act(() => {
      window.dispatchEvent(composing);
    });
    expect(onSkip).not.toHaveBeenCalled();
    act(() => pushDialog("test:nested-over-tour"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onSkip).not.toHaveBeenCalled();
    act(() => popDialog("test:nested-over-tour"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("keeps a provider-owned target measured on scroll and falls back honestly when it disappears", async () => {
    Object.assign(mocks.tourRecord, {
      outcome: "in-progress",
      currentStepId: "sidebar",
      run: 1,
      openedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    let targetRect = new DOMRect(40, 80, 160, 240);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getRect(this: HTMLElement) {
        return this.dataset.tour === "sidebar"
          ? targetRect
          : new DOMRect(0, 0, 280, 160);
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(280);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
    const view = render(
      <TourProvider>
        <button type="button" data-tour="sidebar">
          Sidebar navigation
        </button>
      </TourProvider>,
    );

    let dialog = document.querySelector<HTMLElement>(".tour-tooltip")!;
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    const next = button("Next");
    act(() => {
      next.click();
      next.click();
    });
    expect(mocks.completeStep).toHaveBeenCalledOnce();
    mocks.completeStep.mockClear();
    const initialTop = dialog.style.top;
    targetRect = new DOMRect(520, 420, 120, 80);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    dialog = document.querySelector<HTMLElement>(".tour-tooltip")!;
    expect(dialog.style.top).not.toBe(initialTop);

    view.rerender(
      <TourProvider>
        <span>Sidebar unavailable for this role</span>
      </TourProvider>,
    );
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    await act(async () => Promise.resolve());
    dialog = document.querySelector<HTMLElement>(".tour-tooltip")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain(
      "highlighted area is not available in this workspace view",
    );
    expect(document.body.style.overflow).toBe("hidden");
    expect(mocks.completeStep).not.toHaveBeenCalled();
  });

  it("turns a never-mounted target into an explicit fallback without falsely completing the step", () => {
    vi.useFakeTimers();
    Object.assign(mocks.tourRecord, {
      outcome: "in-progress",
      currentStepId: "sidebar",
      run: 1,
      openedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    render(
      <TourProvider>
        <span>Role-restricted workspace</span>
      </TourProvider>,
    );
    expect(document.querySelector(".tour-tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1300);
    });
    const dialog = document.querySelector<HTMLElement>(".tour-tooltip")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("highlighted area is not available");
    expect(mocks.completeStep).not.toHaveBeenCalled();
  });

  it("cancels target retries when the provider unmounts", () => {
    vi.useFakeTimers();
    Object.assign(mocks.tourRecord, {
      outcome: "in-progress",
      currentStepId: "sidebar",
      run: 1,
      openedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    render(
      <TourProvider>
        <span>Target is still loading</span>
      </TourProvider>,
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(document.querySelector(".tour-tooltip")).toBeNull();
  });

  it("restores exact background isolation, body scrolling, and origin focus after a centered tour closes", async () => {
    Object.assign(mocks.tourRecord, {
      outcome: "in-progress",
      currentStepId: "welcome",
      run: 1,
      openedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    const origin = document.createElement("button");
    origin.textContent = "Open tour";
    origin.setAttribute("aria-hidden", "false");
    document.body.appendChild(origin);
    origin.focus();
    document.body.style.overflow = "clip";
    const view = render(
      <TourProvider>
        <main>Workspace</main>
      </TourProvider>,
    );

    expect(
      document.querySelector(".tour-tooltip")?.getAttribute("aria-modal"),
    ).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(origin.inert).toBe(true);
    expect(origin.getAttribute("aria-hidden")).toBe("true");

    Object.assign(mocks.tourRecord, {
      outcome: "completed",
      currentStepId: null,
      updatedAt: Date.now(),
    });
    view.rerender(
      <TourProvider>
        <main>Workspace</main>
      </TourProvider>,
    );
    await act(async () => Promise.resolve());

    expect(document.querySelector(".tour-tooltip")).toBeNull();
    expect(document.body.style.overflow).toBe("clip");
    expect(origin.inert).toBe(false);
    expect(origin.getAttribute("aria-hidden")).toBe("false");
    expect(document.activeElement).toBe(origin);
  });
});
