// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { LifecycleDecisionDialog } from "../../components/LifecycleDecisionDialog";
import {
  cancelLifecycleTransition,
  registerLifecycleGuard,
  requestLifecycleTransition,
  resetLifecycleCoordinatorForTests,
} from "../../lib/lifecycle-coordinator";

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
  cancelLifecycleTransition();
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  resetLifecycleCoordinatorForTests();
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

describe("LifecycleDecisionDialog", () => {
  it("focuses Cancel, blocks outside dismissal, and allows reviewed warnings", async () => {
    registerLifecycleGuard({
      id: "draft",
      label: "Campaign draft",
      inspect: () => ({
        level: "warning",
        detail: "The subject line is not saved.",
      }),
    });
    const result = requestLifecycleTransition(
      {
        kind: "quit-app",
        title: "Quit Moosewave?",
        description: "Review work before quitting.",
        confirmLabel: "Quit Moosewave",
      },
      () => undefined,
    );
    render(<LifecycleDecisionDialog />);
    await settle();

    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(button("Cancel"));
    expect(document.body.textContent).toContain("Campaign draft");
    const backdrop = document.querySelector<HTMLElement>(".modal-backdrop");
    act(() => {
      backdrop?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

    await act(async () => {
      button("Quit Moosewave").click();
      await result;
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("does not offer continuation while a blocking concern remains", async () => {
    registerLifecycleGuard({
      id: "upload",
      label: "Subscriber upload",
      inspect: () => ({ level: "blocking", detail: "Upload is active." }),
    });
    void requestLifecycleTransition(
      {
        kind: "workspace-switch",
        title: "Switch workspace?",
        description: "Review active work.",
        confirmLabel: "Switch workspace",
      },
      () => undefined,
    );
    render(<LifecycleDecisionDialog />);
    await settle();

    expect(document.body.textContent).toContain("Blocking");
    expect(
      [...document.querySelectorAll("button")].some(
        (candidate) => candidate.textContent?.trim() === "Switch workspace",
      ),
    ).toBe(false);
    expect(button("Recheck")).toBeInstanceOf(HTMLButtonElement);
  });
});
