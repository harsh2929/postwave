// @vitest-environment happy-dom

import { act, StrictMode, type ReactElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Modal } from "../../components/Modal";

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
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function dispatchKey(
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
    key,
  });
  window.dispatchEvent(event);
  return event;
}

function StatefulModal({
  onClose = vi.fn(),
}: {
  onClose?: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" id="modal-trigger" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <div id="background-content">Background content</div>
      <Modal
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Accessible dialog"
        description="Dialog description"
      >
        <button type="button" id="first-action">
          First action
        </button>
        <button type="button" id="last-action">
          Last action
        </button>
      </Modal>
    </>
  );
}

describe("Modal accessibility contract", () => {
  it("labels the dialog and isolates background content while open", () => {
    render(<StatefulModal />);
    const trigger = document.getElementById(
      "modal-trigger",
    ) as HTMLButtonElement;

    act(() => {
      trigger.focus();
      trigger.click();
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");

    const titleId = dialog?.getAttribute("aria-labelledby");
    const descriptionId = dialog?.getAttribute("aria-describedby");
    expect(document.getElementById(titleId ?? "")?.textContent).toBe(
      "Accessible dialog",
    );
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "Dialog description",
    );
    expect(trigger.inert).toBe(true);
    expect(trigger.getAttribute("aria-hidden")).toBe("true");
    expect(document.getElementById("background-content")?.inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(
      document.getElementById("first-action"),
    );
  });

  it("wraps keyboard focus in both directions", () => {
    render(<StatefulModal />);
    act(() => document.getElementById("modal-trigger")?.click());

    const last = document.getElementById("last-action") as HTMLButtonElement;
    const close = document.querySelector<HTMLButtonElement>(".modal-close");
    expect(close).not.toBeNull();

    act(() => {
      last.focus();
      dispatchKey("Tab");
    });
    expect(document.activeElement).toBe(close);

    act(() => {
      close?.focus();
      dispatchKey("Tab", { shiftKey: true });
    });
    expect(document.activeElement).toBe(last);
  });

  it("closes only the top dialog on Escape and restores focus and state", async () => {
    const onClose = vi.fn();
    render(<StatefulModal onClose={onClose} />);
    const trigger = document.getElementById(
      "modal-trigger",
    ) as HTMLButtonElement;

    act(() => {
      trigger.focus();
      trigger.click();
    });
    await act(async () => dispatchKey("Escape"));
    await Promise.resolve();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.inert).toBe(false);
    expect(trigger.hasAttribute("aria-hidden")).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the opener stable through StrictMode's effect rehearsal", async () => {
    render(
      <StrictMode>
        <StatefulModal />
      </StrictMode>,
    );
    const trigger = document.getElementById(
      "modal-trigger",
    ) as HTMLButtonElement;

    act(() => {
      trigger.focus();
      trigger.click();
    });
    await Promise.resolve();

    expect(document.activeElement).toBe(
      document.getElementById("first-action"),
    );

    await act(async () => dispatchKey("Escape"));
    await Promise.resolve();

    expect(document.activeElement).toBe(trigger);
  });

  it("honors an explicit return target when opening blurred the trigger", async () => {
    function ExplicitReturnModal(): ReactElement {
      const [open, setOpen] = useState(false);
      const returnRef = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={returnRef} type="button">
            Resume editing
          </button>
          <button type="button" onClick={() => setOpen(true)}>
            Review discard
          </button>
          <Modal
            open={open}
            onClose={() => setOpen(false)}
            title="Discard changes?"
            returnFocusRef={returnRef}
          >
            <button type="button">Keep editing</button>
          </Modal>
        </>
      );
    }

    render(<ExplicitReturnModal />);
    act(() => {
      const trigger = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === "Review discard",
      );
      trigger?.click();
    });
    await act(async () => dispatchKey("Escape"));
    await Promise.resolve();

    expect(document.activeElement?.textContent).toBe("Resume editing");
  });

  it("keeps composing Escape inert", () => {
    const onClose = vi.fn();
    render(<StatefulModal onClose={onClose} />);
    act(() => document.getElementById("modal-trigger")?.click());
    act(() => {
      dispatchKey("Escape", { isComposing: true });
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("retains focus when every action is disabled", () => {
    render(
      <Modal
        open
        onClose={vi.fn()}
        title="Waiting"
        closeDisabled
        closeOnEscape={false}
      >
        <button type="button" disabled>
          Waiting
        </button>
      </Modal>,
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(document.activeElement).toBe(dialog);
    act(() => {
      dispatchKey("Tab");
    });
    expect(document.activeElement).toBe(dialog);
  });

  it("re-applies meaningful focus when an in-place dialog step changes", () => {
    function SteppedModal(): ReactElement {
      const [step, setStep] = useState(1);
      const headingRef = useRef<HTMLHeadingElement | null>(null);
      return (
        <Modal
          open
          onClose={vi.fn()}
          title={`Step ${step}`}
          initialFocusRef={headingRef}
          focusKey={step}
        >
          <h3 ref={headingRef} tabIndex={-1}>
            Workflow step {step}
          </h3>
          <button type="button" onClick={() => setStep(2)}>
            Next step
          </button>
        </Modal>
      );
    }

    render(<SteppedModal />);
    expect(document.activeElement?.textContent).toBe("Workflow step 1");
    act(() => {
      const next = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === "Next step",
      );
      next?.click();
    });
    expect(document.activeElement?.textContent).toBe("Workflow step 2");
  });
});
