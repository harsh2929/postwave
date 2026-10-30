// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

import { StepCanvas } from "../../components/sequence/StepCanvas";
import { StepEditor } from "../../components/sequence/StepEditor";
import type { CanvasStep } from "../../components/sequence/types";
import { api, type Sequence, type SequenceDetail } from "../../lib/api-client";

vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0);
    return 1;
  };
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  queryClient?.clear();
  queryClient = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient!}>{node}</QueryClientProvider>,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => {
    (element as HTMLElement | null)?.click();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function dispatchEscape(
  target: EventTarget = window,
  init: KeyboardEventInit = {},
): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
        ...init,
      }),
    );
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function seriousViolations(result: axe.AxeResults): axe.Result[] {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

const emailStep: CanvasStep = {
  id: "step-email-1",
  type: "email",
  position: 1,
  subject: "Welcome",
  body: "Hello from Moosewave",
};

function StepEditorHarness({
  onCancel,
  onDelete,
}: {
  onCancel: () => void;
  onDelete: (id: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        id="step-editor-trigger"
        type="button"
        onClick={() => setOpen(true)}
      >
        Edit step
      </button>
      {open ? (
        <StepEditor
          step={emailStep}
          sequenceId="sequence-1"
          isTopLevel
          onSave={vi.fn()}
          onCancel={() => {
            onCancel();
            setOpen(false);
          }}
          onDelete={onDelete}
        />
      ) : null}
    </>
  );
}

function sequence(): Sequence {
  return {
    id: "sequence-1",
    name: "Welcome sequence",
    status: "draft",
    active_runs: 0,
  } as Sequence;
}

function detail(): SequenceDetail {
  return {
    id: "sequence-1",
    name: "Welcome sequence",
    status: "draft",
    active_runs: 0,
    version: 1,
    steps: [
      {
        type: "email",
        position: 1,
        email: { subject: "First email", body: "Hello" },
      },
    ],
  } as SequenceDetail;
}

describe("sequence overlay convergence", () => {
  it("uses one named slideover and protects dirty edits with a topmost cancel-first decision", async () => {
    const onCancel = vi.fn();
    const onDelete = vi.fn();
    render(<StepEditorHarness onCancel={onCancel} onDelete={onDelete} />);
    const trigger = document.getElementById("step-editor-trigger")!;
    act(() => {
      trigger.focus();
      trigger.click();
    });

    const editor = document.querySelector<HTMLElement>('aside[role="dialog"]')!;
    const title = document.getElementById(
      editor.getAttribute("aria-labelledby") ?? "",
    );
    const description = document.getElementById(
      editor.getAttribute("aria-describedby") ?? "",
    );
    expect(title?.textContent).toBe("Edit email step");
    expect(description?.textContent).toContain("Position 1 in sequence");
    expect(description?.textContent).toContain("No unsaved changes");
    expect(document.activeElement).toBe(
      document.getElementById("step-edit-subject"),
    );
    expect(
      seriousViolations(
        await axe.run(editor, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);

    const subject = document.getElementById(
      "step-edit-subject",
    ) as HTMLInputElement;
    setInput(subject, "A changed subject");
    expect(description?.textContent).toContain("Unsaved changes");

    const outerBackdrop =
      document.querySelector<HTMLElement>(".slideover-overlay")!;
    act(() => {
      outerBackdrop.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    subject.focus();
    dispatchEscape(window);
    const discard = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    )!;
    expect(discard.textContent).toContain("Discard unsaved step changes?");
    expect((document.activeElement as HTMLElement).textContent?.trim()).toBe(
      "Cancel",
    );
    const discardBackdrop = discard.closest<HTMLElement>(".modal-backdrop")!;
    act(() => {
      discardBackdrop.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    dispatchEscape(window, { isComposing: true });
    dispatchEscape(window, { keyCode: 229 });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

    dispatchEscape(window);
    await flush();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(subject);

    click(document.querySelector<HTMLButtonElement>(".slideover-close"));
    click(button("Discard changes"));
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector('aside[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("hands delete to the canvas owner and keeps unsafe AI regeneration default-closed", () => {
    const onCancel = vi.fn();
    const onDelete = vi.fn();
    vi.spyOn(api, "regenerateSequenceStep");
    render(<StepEditorHarness onCancel={onCancel} onDelete={onDelete} />);
    click(document.getElementById("step-editor-trigger"));

    click(button("Delete"));
    expect(onDelete).toHaveBeenCalledWith("step-email-1");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    const regenerate = button("Regenerate with AI");
    const reasonId = regenerate.getAttribute("aria-describedby");
    expect(regenerate.disabled).toBe(true);
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId ?? "")?.textContent).toContain(
      "unavailable because the current server mutates before review",
    );
    act(() => {
      regenerate.click();
      regenerate.click();
    });
    expect(api.regenerateSequenceStep).not.toHaveBeenCalled();
    const editor = document.querySelector<HTMLElement>('aside[role="dialog"]')!;
    expect(editor.hasAttribute("aria-busy")).toBe(false);
    expect(
      document.querySelector<HTMLButtonElement>(".slideover-close")?.disabled,
    ).toBe(false);
    dispatchEscape(window);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders canvas deletion as the single destructive contract", async () => {
    vi.spyOn(api, "getSequenceFunnel").mockResolvedValue({
      data: { sequence_id: "sequence-1", steps: [] },
    });
    vi.spyOn(api, "getSequence").mockResolvedValue({ data: detail() });
    vi.spyOn(api, "updateSequence").mockResolvedValue({
      data: { version: 2 },
    });
    render(<StepCanvas sequence={sequence()} canMutate />);
    await flush();

    const deleteTrigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Delete step 1"]',
    )!;
    act(() => {
      deleteTrigger.focus();
      deleteTrigger.click();
    });
    const confirmation = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    )!;
    expect(confirmation.textContent).toContain("Delete email step?");
    expect(confirmation.textContent).toContain("unsaved edits");
    expect((document.activeElement as HTMLElement).textContent?.trim()).toBe(
      "Cancel",
    );
    expect(
      seriousViolations(
        await axe.run(confirmation, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);

    const backdrop = confirmation.closest<HTMLElement>(".modal-backdrop")!;
    act(() => {
      backdrop.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    dispatchEscape(window, { isComposing: true });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    dispatchEscape(window);
    await flush();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(deleteTrigger);

    click(deleteTrigger);
    click(button("Delete step"));
    await flush();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.updateSequence).toHaveBeenCalledTimes(1);
  });
});
