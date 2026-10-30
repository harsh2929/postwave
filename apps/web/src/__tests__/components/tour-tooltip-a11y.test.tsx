// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TourTooltip } from "@/components/tour/TourTooltip";
import type { TourStep } from "@/components/tour/types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const step: TourStep = {
  id: "compose",
  title: "Compose faster",
  body: "Start with a reusable template and personalize from there.",
  placement: "center",
};

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

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function findButton(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

function sendKey(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

describe("TourTooltip accessibility", () => {
  it("labels the modal tooltip, focuses the primary action, and traps Tab", async () => {
    const onNext = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();
    const root = render(
      createElement(TourTooltip, {
        step,
        stepIndex: 0,
        totalSteps: 3,
        rect: null,
        isLast: false,
        onNext,
        onBack,
        onSkip,
      }),
    );

    try {
      await act(async () => {
        await flush();
      });

      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const skip = findButton("Skip");
      const next = findButton("Next");

      expect(dialog).toBeTruthy();
      expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
      expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
      expect(document.activeElement).toBe(next);

      sendKey("Tab");
      expect(document.activeElement).toBe(skip);

      sendKey("Tab", { shiftKey: true });
      expect(document.activeElement).toBe(next);

      await act(async () => {
        skip.click();
        next.click();
        await flush();
      });

      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onNext).toHaveBeenCalledTimes(1);
      expect(onBack).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("exposes Back on later steps and wires it to the previous-step action", async () => {
    const onNext = vi.fn();
    const onBack = vi.fn();
    const onSkip = vi.fn();
    const root = render(
      createElement(TourTooltip, {
        step,
        stepIndex: 1,
        totalSteps: 3,
        rect: null,
        isLast: false,
        onNext,
        onBack,
        onSkip,
      }),
    );

    try {
      await act(async () => {
        await flush();
      });

      await act(async () => {
        findButton("Back").click();
        await flush();
      });

      expect(onBack).toHaveBeenCalledTimes(1);
      expect(onNext).not.toHaveBeenCalled();
      expect(onSkip).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
