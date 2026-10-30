// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegenerateEmailDialog } from "@/app/(dashboard)/app/sequences/[id]/regenerate-email-dialog";
import {
  FidelityBreakdown,
  FidelityChip,
} from "@/app/(dashboard)/app/sequences/[id]/sequence-fidelity";
import type { SequenceEmail, StyleControls } from "@/lib/voice-types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.includes(text) === true,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function textareaById(id: string): HTMLTextAreaElement {
  const textarea = document.getElementById(id);
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error(`Textarea not found: ${id}`);
  }
  return textarea;
}

function rangeByLabel(label: string): HTMLInputElement {
  const wrapper = Array.from(document.querySelectorAll("div")).find(
    (element) => element.textContent?.includes(label) === true,
  );
  const input = wrapper?.querySelector('input[type="range"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Range input not found: ${label}`);
  }
  return input;
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeRange(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function email(patch: Partial<SequenceEmail> = {}): SequenceEmail {
  return {
    id: "email-1",
    position: 2,
    subject: "Welcome",
    bodyMarkdown: "Hello",
    bodyHtml: "",
    bodyMjml: null,
    delayHours: 4,
    fidelity: 86,
    fidelityBreakdown: {
      embedding: 92,
      stylistic: 81,
      vocab: 76,
      structural: 88,
    },
    fidelityBreakdownPresent: true,
    ...patch,
  };
}

const style: StyleControls = {
  humor: 0,
  directness: 0.2,
  lengthBias: -0.1,
  formality: 0,
};

describe("sequence detail components", () => {
  it("maps fidelity scores to badge classes and expands the breakdown", () => {
    const root = render(
      createElement("div", null, [
        createElement(FidelityChip, { key: "green", score: 91 }),
        createElement(FidelityChip, { key: "amber", score: 70 }),
        createElement(FidelityChip, { key: "red", score: 42 }),
        createElement(FidelityBreakdown, { key: "breakdown", email: email() }),
      ]),
    );

    try {
      expect(document.body.textContent).toContain("Voice fidelity - 86/100");
      expect(document.body.textContent).not.toContain("Embedding similarity");
      expect(document.body.textContent).toContain("91");
      expect(document.body.textContent).toContain("70");
      expect(document.body.textContent).toContain("42");
      expect(document.body.innerHTML).toContain("text-success");
      expect(document.body.innerHTML).toContain("text-warning-emphasis");
      expect(document.body.innerHTML).toContain("text-destructive");

      act(() => {
        buttonByText("Show breakdown").click();
      });

      expect(document.body.textContent).toContain("Embedding similarity");
      expect(document.body.textContent).toContain("Structural patterns");
      expect(document.body.textContent).toContain("88");
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not show fabricated component bars when diagnostics are absent", () => {
    const root = render(
      createElement(FidelityBreakdown, {
        email: email({ fidelityBreakdownPresent: false }),
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "Component scores unavailable",
      );
      expect(document.body.textContent).not.toContain("Embedding similarity");
      expect(document.querySelector("button")?.disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("routes regenerate dialog edits and actions through caller callbacks", () => {
    const onAccept = vi.fn<() => void>();
    const onAdjust = vi.fn<() => void>();
    const onHintChange = vi.fn<(value: string) => void>();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const onRegenerate = vi.fn<() => void>();
    const onStyleChange = vi.fn<(next: StyleControls) => void>();
    const root = render(
      createElement(RegenerateEmailDialog, {
        accepting: false,
        candidate: null,
        currentEmail: email(),
        emailPosition: 2,
        error: null,
        generating: false,
        hint: "Make it shorter",
        onAccept,
        onAdjust,
        onHintChange,
        onNewAttempt: vi.fn(),
        onOpenChange,
        onRegenerate,
        onStyleChange,
        open: true,
        returnFocus: { current: null },
        style,
      }),
    );

    try {
      expect(document.body.textContent).toContain("Regenerate email #2");
      expect(textareaById("regeneration-hint").value).toBe("Make it shorter");
      expect(document.body.textContent).toContain(
        "Nothing changes until you accept and save",
      );

      act(() => {
        changeTextarea(textareaById("regeneration-hint"), "Add founder story");
      });
      expect(onHintChange).toHaveBeenCalledWith("Add founder story");

      act(() => {
        changeRange(rangeByLabel("Humor"), "0.7");
      });
      expect(onStyleChange).toHaveBeenCalledWith({
        ...style,
        humor: 0.7,
      });

      act(() => {
        buttonByText("Generate preview").click();
      });
      expect(onRegenerate).toHaveBeenCalledTimes(1);

      act(() => {
        buttonByText("Cancel").click();
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders candidate copy as text and requires explicit acceptance", () => {
    const onAccept = vi.fn<() => void>();
    const onAdjust = vi.fn<() => void>();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const candidate = email({
      subject: "Candidate subject",
      bodyMarkdown: '<img src=x onerror="alert(1)"> Candidate body',
      fidelity: 93,
      regenerationCount: 2,
    });
    const root = render(
      createElement(RegenerateEmailDialog, {
        accepting: false,
        candidate,
        currentEmail: email({ subject: "Current subject" }),
        emailPosition: 2,
        error: null,
        generating: false,
        hint: "",
        onAccept,
        onAdjust,
        onHintChange: vi.fn(),
        onNewAttempt: vi.fn(),
        onOpenChange,
        onRegenerate: vi.fn(),
        onStyleChange: vi.fn(),
        open: true,
        returnFocus: { current: null },
        style,
      }),
    );

    try {
      expect(document.body.textContent).toContain("Current subject");
      expect(document.body.textContent).toContain("Candidate subject");
      expect(document.body.textContent).toContain(
        "This candidate is not saved",
      );
      expect(document.querySelector('img[src="x"]')).toBeNull();

      act(() => buttonByText("Accept & save").click());
      expect(onAccept).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();

      act(() => buttonByText("Adjust prompt").click());
      expect(onAdjust).toHaveBeenCalledTimes(1);

      act(() => buttonByText("Discard preview").click());
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("restores focus to the controlled dialog launch button", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      const returnFocus = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={returnFocus} type="button">
            Regeneration launch control
          </button>
          <RegenerateEmailDialog
            accepting={false}
            candidate={null}
            currentEmail={email()}
            emailPosition={2}
            error={null}
            generating={false}
            hint=""
            onAccept={vi.fn()}
            onAdjust={vi.fn()}
            onHintChange={vi.fn()}
            onNewAttempt={vi.fn()}
            onOpenChange={setOpen}
            onRegenerate={vi.fn()}
            onStyleChange={vi.fn()}
            open={open}
            returnFocus={returnFocus}
            style={style}
          />
        </>
      );
    }

    const root = render(<Harness />);
    try {
      await act(async () => {
        buttonByText("Cancel").click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(document.activeElement?.textContent).toContain(
        "Regeneration launch control",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
