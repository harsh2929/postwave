// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  choose: vi.fn(async () => undefined),
  dismissRecovery: vi.fn(),
}));

vi.mock("../../lib/desktop-window-lifecycle", () => ({
  cancelDesktopCloseEducation: mocks.cancel,
  chooseDesktopCloseBehavior: mocks.choose,
  dismissInterruptedShutdownRecovery: mocks.dismissRecovery,
  recommendedDesktopCloseBehavior: () => "hide",
  useDesktopWindowLifecycleState: () => ({
    closeBehavior: "ask",
    closeEducationOpen: true,
    platform: "macos",
    recoveredInterruptedShutdown: false,
  }),
}));

import { DesktopCloseEducationDialog } from "../../components/DesktopLifecycleService";

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
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

describe("DesktopCloseEducationDialog", () => {
  it("explains both outcomes, focuses cancel, and has no backdrop dismissal", () => {
    render(<DesktopCloseEducationDialog />);

    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(button("Cancel"));
    expect(document.body.textContent).toContain("Keep running in the tray");
    expect(document.body.textContent).toContain("Quit Moosewave");
    expect(document.body.textContent).toContain("Recommended");

    act(() => {
      document
        .querySelector<HTMLElement>(".modal-backdrop")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("routes the explicit tray choice to the close service", () => {
    render(<DesktopCloseEducationDialog />);
    act(() => button("Keep running").click());
    expect(mocks.choose).toHaveBeenCalledWith("hide");
  });
});
