// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
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

import type { Segment } from "../../components/segments/segmentsClient";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  configureHoldout: vi.fn(),
  createLookalike: vi.fn(),
  compare: vi.fn(),
  engagement: vi.fn(),
  growth: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  LOOKALIKE_DEFAULT_SIZE: 1000,
  LOOKALIKE_MAX_SIZE: 10_000,
  LOOKALIKE_MIN_SIZE: 100,
  createLookalikeAudience: mocks.createLookalike,
  segmentInsightsApi: { growth: mocks.growth },
}));

vi.mock("../../components/segments/segmentPnlClient", () => ({
  segmentPnlClient: {
    compare: mocks.compare,
    configureHoldout: mocks.configureHoldout,
    engagementSummary: mocks.engagement,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { LookalikeModal } from "../../components/audiences/LookalikeModal";
import { SegmentCompareView } from "../../components/segments/SegmentCompareView";
import { SegmentHoldoutConfigModal } from "../../components/segments/SegmentHoldoutConfigModal";
import { SegmentPerformanceComparison } from "../../components/segments/SegmentPerformanceComparison";

type Owner = "lookalike" | "holdout" | "performance" | "pnl";

const segments: Segment[] = [
  { id: "segment-1", name: "Engaged readers", lastCount: 75 },
  { id: "segment-2", name: "New readers", lastCount: 60 },
  { id: "segment-3", name: "At risk", lastCount: 55 },
];

const cases: readonly {
  owner: Owner;
  title: string;
  description: string;
  initialSelector: string;
}[] = [
  {
    owner: "lookalike",
    title: "Create lookalike audience",
    description:
      "Build an audience of subscribers most similar to a seed segment using first-party email, signup, engagement, and churn signals only.",
    initialSelector: "#lookalike-seed",
  },
  {
    owner: "holdout",
    title: "Configure segment holdout",
    description:
      "Withhold a deterministic random slice of this segment to measure incremental messaging lift against the treated group.",
    initialSelector: 'input[type="range"]',
  },
  {
    owner: "performance",
    title: "Audience performance comparison",
    description:
      "Compare two to five segments across revenue, revenue per recipient, engagement rates, and audience growth over one window.",
    initialSelector: 'input[type="checkbox"]',
  },
  {
    owner: "pnl",
    title: "Compare segment P&L",
    description:
      "Compare two to five segments across net contribution per member, revenue, average order value, costs, and audience outcomes.",
    initialSelector: 'input[type="checkbox"]',
  },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createLookalike.mockResolvedValue({
    data: {
      id: "audience-1",
      name: "Readers alike",
      seed_segment_id: "segment-1",
      size_requested: 1000,
      member_count: 80,
      seed_count: 75,
      confidence_threshold: 0.8,
      model_version: "first-party-v1",
      status: "ready",
      created_at: "2026-07-17T08:00:00Z",
    },
  });
  mocks.configureHoldout.mockResolvedValue({ data: {} });
  mocks.compare.mockResolvedValue({ data: { items: [] } });
  mocks.engagement.mockResolvedValue({
    data: { member_count: 75, sends: 0 },
  });
  mocks.growth.mockResolvedValue({
    data: { delta: 0, delta_pct: 0, series: [] },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  resetLifecycleCoordinatorForTests();
  vi.clearAllMocks();
});

function OwnerSurface({
  owner,
  onClose,
}: {
  owner: Owner;
  onClose: () => void;
}): ReactElement {
  if (owner === "lookalike") {
    return (
      <LookalikeModal
        segments={segments}
        canMutate
        onClose={onClose}
        onCreated={vi.fn()}
      />
    );
  }
  if (owner === "holdout") {
    return (
      <SegmentHoldoutConfigModal
        segmentId="segment-1"
        onClose={onClose}
        onConfigured={vi.fn()}
      />
    );
  }
  if (owner === "performance") {
    return (
      <SegmentPerformanceComparison segments={segments} onClose={onClose} />
    );
  }
  return <SegmentCompareView segments={segments} onClose={onClose} />;
}

function Harness({ owner }: { owner: Owner }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        id={`trigger-${owner}`}
        type="button"
        onClick={() => setOpen(true)}
      >
        Open {owner}
      </button>
      <div id={`background-${owner}`}>Background</div>
      {open ? (
        <OwnerSurface owner={owner} onClose={() => setOpen(false)} />
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

function dispatchEscape(
  target: HTMLElement,
  options: { composing?: boolean; keyCode?: number } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    isComposing: options.composing,
    key: "Escape",
  });
  if (options.keyCode !== undefined) {
    Object.defineProperty(event, "keyCode", { value: options.keyCode });
  }
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function setInput(target: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  );
  if (!descriptor?.set) throw new Error("Missing native input setter");
  act(() => {
    descriptor.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function click(target: HTMLElement): void {
  act(() => target.click());
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function expectModalBodyControlsLocked(): void {
  const controls = [
    ...document.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >(".modal-body button, .modal-body input, .modal-body select"),
  ];
  expect(controls.length).toBeGreaterThan(0);
  expect(controls.every((control) => control.disabled)).toBe(true);
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DUX-009/022 segment overlay behavior", () => {
  for (const ownerCase of cases) {
    it(`${ownerCase.owner} owns naming, focus, Escape, backdrop, and axe semantics`, async () => {
      render(<Harness owner={ownerCase.owner} />);
      const trigger = document.getElementById(`trigger-${ownerCase.owner}`)!;
      act(() => {
        trigger.focus();
        trigger.click();
      });
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      const title = document.getElementById(
        dialog.getAttribute("aria-labelledby")!,
      );
      const description = document.getElementById(
        dialog.getAttribute("aria-describedby")!,
      );
      expect(title?.textContent).toBe(ownerCase.title);
      expect(description?.textContent).toBe(ownerCase.description);
      expect(document.activeElement).toBe(
        dialog.querySelector(ownerCase.initialSelector),
      );
      expect(trigger.inert).toBe(true);
      expect(
        document.getElementById(`background-${ownerCase.owner}`)?.inert,
      ).toBe(true);
      const result = await axe.run(container!, {
        rules: { region: { enabled: false } },
      });
      expect(result.violations).toEqual([]);

      const active = document.activeElement as HTMLElement;
      dispatchEscape(active, { composing: true });
      dispatchEscape(active, { keyCode: 229 });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      dispatchEscape(active);
      await flush();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it(`${ownerCase.owner} closes from its non-busy backdrop`, async () => {
      render(<Harness owner={ownerCase.owner} />);
      const trigger = document.getElementById(`trigger-${ownerCase.owner}`)!;
      act(() => {
        trigger.focus();
        trigger.click();
      });
      await flush();
      const backdrop = document.querySelector<HTMLElement>(".modal-backdrop")!;
      act(() => {
        backdrop.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true }),
        );
      });
      await flush();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  }

  for (const owner of ["lookalike", "holdout"] as const) {
    it(`${owner} keeps its dirty confirm topmost and IME-safe`, async () => {
      render(<Harness owner={owner} />);
      click(document.getElementById(`trigger-${owner}`)!);
      const dirtyInput =
        owner === "lookalike"
          ? document.getElementById("lookalike-name")
          : document.querySelector('input[type="range"]');
      setInput(
        dirtyInput as HTMLInputElement,
        owner === "lookalike" ? "Draft" : "20",
      );
      act(() => (dirtyInput as HTMLElement).focus());
      dispatchEscape(dirtyInput as HTMLElement);
      expect(
        document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
      ).toHaveLength(2);
      const outerBackdrop = document
        .querySelector<HTMLElement>('[role="dialog"]')
        ?.closest<HTMLElement>(".modal-backdrop");
      expect(outerBackdrop?.inert).toBe(true);
      expect(outerBackdrop?.getAttribute("aria-hidden")).toBe("true");
      const nestedResult = await axe.run(container!, {
        rules: { region: { enabled: false } },
      });
      expect(nestedResult.violations).toEqual([]);
      const innerBackdrop = document
        .querySelector<HTMLElement>('[role="alertdialog"]')
        ?.closest<HTMLElement>(".modal-backdrop");
      act(() => {
        innerBackdrop?.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true }),
        );
      });
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      const cancel = document.activeElement as HTMLButtonElement;
      expect(cancel.textContent?.trim()).toBe("Cancel");
      dispatchEscape(cancel, { composing: true });
      dispatchEscape(cancel, { keyCode: 229 });
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      dispatchEscape(cancel);
      await flush();
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(outerBackdrop?.inert).toBe(false);
      expect(outerBackdrop?.hasAttribute("aria-hidden")).toBe(false);
      expect(document.activeElement).toBe(dirtyInput);
    });
  }

  it("locks lookalike dismissal for the exact generation request", async () => {
    const pending =
      deferred<Awaited<ReturnType<typeof mocks.createLookalike>>>();
    mocks.createLookalike.mockReturnValueOnce(pending.promise);
    render(<Harness owner="lookalike" />);
    const trigger = document.getElementById("trigger-lookalike")!;
    act(() => {
      trigger.focus();
      trigger.click();
    });
    click(
      document.querySelector<HTMLInputElement>(
        ".lookalike-acknowledgement input",
      )!,
    );
    click(button("Create lookalike"));
    expect(
      document.querySelector<HTMLButtonElement>(".modal-close")?.disabled,
    ).toBe(true);
    expectModalBodyControlsLocked();
    const backdrop = document.querySelector<HTMLElement>(".modal-backdrop")!;
    act(() => {
      backdrop.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    dispatchEscape(button("Generating…"));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      pending.resolve({
        data: {
          id: "audience-1",
          name: "Readers alike",
          seed_segment_id: "segment-1",
          size_requested: 1000,
          member_count: 80,
          seed_count: 75,
          confidence_threshold: 0.8,
          model_version: "first-party-v1",
          status: "ready",
          created_at: "2026-07-17T08:00:00Z",
        },
      });
      await pending.promise;
    });
    await flush();
    const resultDialog =
      document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(
      document.getElementById(resultDialog.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe("Readers alike");
    expect(
      document.getElementById(resultDialog.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe(
      "This materialized audience is ready to target from a campaign or flow like any saved segment.",
    );
    const done = button("Done");
    expect(document.activeElement).toBe(done);
    click(done);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("locks holdout dismissal for the exact save request", async () => {
    const pending = deferred<{ data: Record<string, never> }>();
    mocks.configureHoldout.mockReturnValueOnce(pending.promise);
    render(<Harness owner="holdout" />);
    click(document.getElementById("trigger-holdout")!);
    click(button("Save holdout"));
    expect(
      document.querySelector<HTMLButtonElement>(".modal-close")?.disabled,
    ).toBe(true);
    expectModalBodyControlsLocked();
    const backdrop = document.querySelector<HTMLElement>(".modal-backdrop")!;
    act(() => {
      backdrop.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    dispatchEscape(button("Saving…"));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      pending.resolve({ data: {} });
      await pending.promise;
    });
  });

  for (const owner of ["performance", "pnl"] as const) {
    it(`${owner} prevents dismissal while comparison data is in flight`, async () => {
      const pending = deferred<{ data: { items: never[] } }>();
      mocks.compare.mockReturnValueOnce(pending.promise);
      render(<Harness owner={owner} />);
      click(document.getElementById(`trigger-${owner}`)!);
      const checkboxes = [
        ...document.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]',
        ),
      ];
      click(checkboxes[0]!);
      click(checkboxes[1]!);
      click(button("Compare"));
      expect(
        document.querySelector<HTMLButtonElement>(".modal-close")?.disabled,
      ).toBe(true);
      expectModalBodyControlsLocked();
      const backdrop = document.querySelector<HTMLElement>(".modal-backdrop")!;
      act(() => {
        backdrop.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true }),
        );
      });
      dispatchEscape(button("Comparing…"));
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => {
        pending.resolve({ data: { items: [] } });
        await pending.promise;
      });
    });
  }
});
