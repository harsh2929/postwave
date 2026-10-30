// @vitest-environment happy-dom

import axe, { type AxeResults } from "axe-core";
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

import type {
  OnboardingProgress,
  OnboardingStep,
} from "../../hooks/useOnboardingProgress";

const mocks = vi.hoisted(() => ({
  onboarding: {
    openSurface: vi.fn(),
    state: {
      scopeToken: "workspace-a:user-a",
    },
  },
  progress: undefined as unknown as OnboardingProgress,
  reducedMotion: true,
}));

vi.mock("../../hooks/useOnboardingProgress", () => ({
  useOnboardingProgress: () => mocks.progress,
}));

vi.mock("../../hooks/useOnboardingState", () => ({
  useOnboardingState: () => mocks.onboarding,
}));

vi.mock("../../hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => mocks.reducedMotion,
}));

import { OnboardingChecklist } from "../../components/OnboardingChecklist";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reducedMotion = true;
  mocks.progress = createProgress();
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createStep(
  values: Pick<
    OnboardingStep,
    "id" | "title" | "description" | "unlockedBadge" | "goLabel" | "status"
  >,
): OnboardingStep {
  return {
    ...values,
    goTo: vi.fn(),
  };
}

function createSteps(): OnboardingStep[] {
  return [
    createStep({
      id: "verify-domain",
      title: "Verify your sending domain",
      description: "Publish and verify your sending records.",
      unlockedBadge: "DKIM verified",
      goLabel: "Open Custom Domains",
      status: "complete",
    }),
    createStep({
      id: "import-subscribers",
      title: "Import your first subscribers",
      description: "Add an audience that can receive your first campaign.",
      unlockedBadge: "Audience ready",
      goLabel: "Add subscribers",
      status: "active",
    }),
    createStep({
      id: "send-first-campaign",
      title: "Send your first campaign",
      description: "Create, test, and schedule your first broadcast.",
      unlockedBadge: "First send complete",
      goLabel: "Open Campaigns",
      status: "pending",
    }),
    createStep({
      id: "connect-events",
      title: "Connect your site or app",
      description: "Start sending product events to Moosewave.",
      unlockedBadge: "Real-time events flowing",
      goLabel: "Open Track",
      status: "pending",
    }),
    createStep({
      id: "harden-deliverability",
      title: "Harden deliverability",
      description: "Configure the controls that protect inbox placement.",
      unlockedBadge: "Deliverability hardened",
      goLabel: "Open DMARC",
      status: "pending",
    }),
  ];
}

function createProgress(
  overrides: Partial<OnboardingProgress> = {},
): OnboardingProgress {
  return {
    steps: createSteps(),
    completedStepIds: ["verify-domain"],
    completion: 0.2,
    ratio: { done: 1, total: 5 },
    done: false,
    dismissed: false,
    applicable: true,
    available: true,
    liveConfirmed: true,
    loading: false,
    refreshing: false,
    failed: false,
    stale: false,
    retry: vi.fn(),
    dismiss: vi.fn(),
    restore: vi.fn(),
    skipStep: vi.fn(),
    ...overrides,
  };
}

function renderChecklist(
  node: ReactElement = <OnboardingChecklist variant="compact" />,
): { rerender: (next?: ReactElement) => void } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next = <OnboardingChecklist variant="compact" />) {
      act(() => root?.render(next));
    },
  };
}

function normalizedText(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function buttonWithText(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => normalizedText(candidate) === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function buttonWithLabel(label: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!match) throw new Error(`Missing labelled button: ${label}`);
  return match;
}

function click(control: HTMLElement): void {
  act(() => control.click());
}

function seriousOrCritical(result: AxeResults) {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

describe("OnboardingChecklist compact/full contract", () => {
  it("opens each active setup step once across fresh hook identities", () => {
    const view = renderChecklist();
    const firstOpen = mocks.onboarding.openSurface;

    expect(firstOpen).toHaveBeenCalledOnce();
    expect(firstOpen).toHaveBeenCalledWith(
      "checklist",
      "auto",
      "import-subscribers",
    );

    const replacementOpen = vi.fn();
    mocks.onboarding.openSurface = replacementOpen;
    mocks.progress = createProgress({ steps: createSteps() });
    view.rerender();

    expect(replacementOpen).not.toHaveBeenCalled();

    mocks.progress = createProgress({
      steps: createSteps().map((step) => ({
        ...step,
        status:
          step.id === "import-subscribers"
            ? ("complete" as const)
            : step.id === "send-first-campaign"
              ? ("active" as const)
              : step.status,
      })),
    });
    view.rerender();

    expect(replacementOpen).toHaveBeenCalledOnce();
    expect(replacementOpen).toHaveBeenCalledWith(
      "checklist",
      "auto",
      "send-first-campaign",
    );
  });

  it("renders the active next step and invokes its primary CTA", () => {
    renderChecklist();

    expect(container?.textContent).toContain("Next step");
    expect(container?.textContent).toContain("Import your first subscribers");
    expect(container?.textContent).toContain(
      "Add an audience that can receive your first campaign.",
    );
    expect(container?.textContent).not.toContain("Path to your first send");

    click(buttonWithText("Add subscribers"));

    expect(mocks.progress.steps[1]?.goTo).toHaveBeenCalledOnce();
  });

  it("exposes exact workspace progressbar semantics", () => {
    renderChecklist();

    const progressbar = document.querySelector<HTMLElement>(
      '[role="progressbar"][aria-label="Workspace setup progress"]',
    );
    expect(progressbar).not.toBeNull();
    expect(progressbar?.getAttribute("aria-valuemin")).toBe("0");
    expect(progressbar?.getAttribute("aria-valuemax")).toBe("5");
    expect(progressbar?.getAttribute("aria-valuenow")).toBe("1");
    expect(progressbar?.getAttribute("aria-valuetext")).toBe(
      "1 of 5 steps resolved",
    );
  });

  it("expands and collapses all steps inline with a stable disclosure target", () => {
    renderChecklist();

    const viewAll = buttonWithText("View all steps");
    const controlledId = viewAll.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    expect(viewAll.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(controlledId!)?.hidden).toBe(true);

    click(viewAll);

    const expandedPanel = document.getElementById(controlledId!);
    const showLess = buttonWithText("Show less");
    expect(expandedPanel).not.toBeNull();
    expect(expandedPanel?.classList.contains("checklist-groups")).toBe(true);
    expect(expandedPanel?.hidden).toBe(false);
    expect(
      document.querySelector("section.checklist-compact-expanded"),
    ).not.toBeNull();
    expect(showLess.getAttribute("aria-expanded")).toBe("true");
    expect(showLess.getAttribute("aria-controls")).toBe(controlledId);
    expect(container?.textContent).toContain("Path to your first send");
    expect(container?.textContent).toContain("Make it durable");

    click(showLess);

    const collapsedControl = buttonWithText("View all steps");
    expect(collapsedControl.getAttribute("aria-expanded")).toBe("false");
    expect(collapsedControl.getAttribute("aria-controls")).toBe(controlledId);
    expect(document.getElementById(controlledId!)?.hidden).toBe(true);
    expect(container?.textContent).toContain("Import your first subscribers");
  });

  it("renders one disclosure control per incomplete step", () => {
    renderChecklist(<OnboardingChecklist variant="full" />);

    const incompleteSteps = mocks.progress.steps.filter(
      (step) => step.status !== "complete",
    );
    const disclosures = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".checklist-step-toggle[aria-expanded]",
      ),
    );
    expect(disclosures).toHaveLength(incompleteSteps.length);

    for (const step of incompleteSteps) {
      const matches = disclosures.filter((control) =>
        normalizedText(control).includes(step.title),
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.getAttribute("aria-controls")).toBeTruthy();
    }

    const completedControl = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".checklist-step-toggle"),
    ).find((control) =>
      normalizedText(control).includes("Verify your sending domain"),
    );
    expect(completedControl?.disabled).toBe(true);
    expect(completedControl?.hasAttribute("aria-expanded")).toBe(false);

    const campaignDisclosure = disclosures.find((control) =>
      normalizedText(control).includes("Send your first campaign"),
    );
    expect(campaignDisclosure).toBeTruthy();
    const campaignBody = document.getElementById(
      campaignDisclosure!.getAttribute("aria-controls")!,
    );
    expect(campaignBody).not.toBeNull();
    expect(campaignBody?.hidden).toBe(true);
    click(campaignDisclosure!);
    expect(campaignDisclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(campaignBody?.hidden).toBe(false);
    expect(campaignBody?.textContent).toContain(
      "Create, test, and schedule your first broadcast.",
    );

    click(campaignDisclosure!);
    expect(campaignDisclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(campaignBody?.hidden).toBe(true);
  });

  it("follows a newly active step while preserving an intentional collapse", () => {
    const view = renderChecklist(<OnboardingChecklist variant="full" />);
    const importControl = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".checklist-step-toggle[aria-expanded]",
      ),
    ).find((control) =>
      normalizedText(control).includes("Import your first subscribers"),
    );
    expect(importControl?.getAttribute("aria-expanded")).toBe("true");

    const advancedSteps = createSteps().map((step) => ({
      ...step,
      status:
        step.id === "import-subscribers"
          ? ("complete" as const)
          : step.id === "send-first-campaign"
            ? ("active" as const)
            : step.status,
    }));
    mocks.progress = createProgress({
      steps: advancedSteps,
      completedStepIds: ["verify-domain", "import-subscribers"],
      completion: 0.4,
      ratio: { done: 2, total: 5 },
    });
    view.rerender(<OnboardingChecklist variant="full" />);

    const campaignControl = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".checklist-step-toggle[aria-expanded]",
      ),
    ).find((control) =>
      normalizedText(control).includes("Send your first campaign"),
    );
    expect(campaignControl?.getAttribute("aria-expanded")).toBe("true");

    click(campaignControl!);
    expect(campaignControl?.getAttribute("aria-expanded")).toBe("false");

    mocks.progress = createProgress({
      steps: advancedSteps.map((step) => ({ ...step })),
      completedStepIds: ["verify-domain", "import-subscribers"],
      completion: 0.4,
      ratio: { done: 2, total: 5 },
    });
    view.rerender(<OnboardingChecklist variant="full" />);
    const collapsedCampaign = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".checklist-step-toggle[aria-expanded]",
      ),
    ).find((control) =>
      normalizedText(control).includes("Send your first campaign"),
    );
    expect(collapsedCampaign?.getAttribute("aria-expanded")).toBe("false");
  });

  it("dismisses the guide and exposes a reversible Restore state", () => {
    const view = renderChecklist();

    click(buttonWithLabel("Hide setup guide; it can be restored later"));
    expect(mocks.progress.dismiss).toHaveBeenCalledOnce();

    const restore = vi.fn();
    mocks.progress = createProgress({ dismissed: true, restore });
    view.rerender();

    expect(
      document.querySelector('section[aria-label="Setup guide (hidden)"]'),
    ).not.toBeNull();
    expect(container?.textContent).toContain("Setup guide hidden");
    click(buttonWithText("Restore"));
    expect(restore).toHaveBeenCalledOnce();
  });

  it("renders an announced compact loading skeleton without task actions", () => {
    mocks.progress = createProgress({
      available: false,
      liveConfirmed: false,
      loading: true,
    });

    renderChecklist();

    const status = document.querySelector<HTMLElement>(
      '.checklist-compact-loading[role="status"]',
    );
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("Loading workspace setup progress");
    expect(status?.querySelectorAll(".skel")).toHaveLength(3);
    expect(document.querySelector(".checklist-compact-next")).toBeNull();
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (control) => normalizedText(control) === "View all steps",
      ),
    ).toBe(false);
  });

  it("replaces an initial load failure with a safe retryable state", async () => {
    const retry = vi.fn();
    mocks.progress = createProgress({
      available: false,
      liveConfirmed: false,
      loading: false,
      failed: true,
      retry,
    });

    renderChecklist();

    const alert = document.querySelector<HTMLElement>(
      '.checklist-load-error[role="alert"]',
    );
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Setup progress is unavailable");
    expect(alert?.textContent).toContain(
      "We couldn't load your latest setup progress.",
    );
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(document.querySelector(".checklist-compact-next")).toBeNull();
    expect(
      document.querySelector(
        'button[aria-label="Hide setup guide; it can be restored later"]',
      ),
    ).toBeNull();

    click(buttonWithText("Retry setup progress"));
    expect(retry).toHaveBeenCalledOnce();
    expect(seriousOrCritical(await axe.run(container!))).toEqual([]);
  });

  it("keeps cached steps visible when refresh fails and offers retry", () => {
    const retry = vi.fn();
    mocks.progress = createProgress({
      liveConfirmed: false,
      failed: true,
      stale: true,
      retry,
    });

    renderChecklist();

    const warning = document.querySelector<HTMLElement>(
      ".checklist-data-notice.is-warning",
    );
    expect(warning?.textContent).toContain(
      "Showing the last confirmed status.",
    );
    expect(container?.textContent).toContain("Import your first subscribers");
    expect(document.querySelector(".checklist-load-error")).toBeNull();

    click(buttonWithText("Retry"));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("labels a background refresh without replacing cached progress", () => {
    mocks.progress = createProgress({
      liveConfirmed: false,
      refreshing: true,
    });

    renderChecklist();

    expect(
      document.querySelector('.checklist-data-notice[role="status"]')
        ?.textContent,
    ).toContain("Refreshing setup progress");
    expect(container?.textContent).toContain("Import your first subscribers");
    expect(document.querySelector(".checklist-compact-loading")).toBeNull();
  });

  it("renders nothing when settled progress is already done", () => {
    const completeSteps = createSteps().map((step) => ({
      ...step,
      status: "complete" as const,
    }));
    mocks.progress = createProgress({
      steps: completeSteps,
      completedStepIds: completeSteps.map((step) => step.id),
      completion: 1,
      ratio: { done: 5, total: 5 },
      done: true,
    });

    renderChecklist();

    expect(container?.childElementCount).toBe(0);
    expect(mocks.onboarding.openSurface).not.toHaveBeenCalled();
  });

  it("has no serious or critical axe violations when compact or expanded", async () => {
    renderChecklist();

    const compactResult = await axe.run(container!);
    expect(seriousOrCritical(compactResult)).toEqual([]);

    click(buttonWithText("View all steps"));
    const expandedResult = await axe.run(container!);
    expect(seriousOrCritical(expandedResult)).toEqual([]);
  });
});
