// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/store", () => ({
  useMe: () => null,
}));

import {
  resetOnboardingStateForTests,
  useOnboardingState,
} from "../../hooks/useOnboardingState";

let container: HTMLDivElement;
let root: Root;

function Probe(): ReactElement {
  const onboarding = useOnboardingState();
  const tour = onboarding.state.surfaces.tour;
  return (
    <>
      <span data-testid="ready">{String(onboarding.ready)}</span>
      <span data-testid="outcome">{tour.outcome}</span>
      <span data-testid="step">{tour.currentStepId ?? "none"}</span>
      <button
        type="button"
        onClick={() =>
          onboarding.openSurface(
            "tour",
            "manual",
            "workspace-welcome",
            { stepCount: 56, stepIndex: 0 },
          )
        }
      >
        Start full walkthrough
      </button>
    </>
  );
}

beforeEach(() => {
  resetOnboardingStateForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetOnboardingStateForTests();
});

describe("signed-out manual walkthrough", () => {
  it("opens from Settings without enabling automatic onboarding", () => {
    act(() => root.render(<Probe />));

    expect(container.querySelector('[data-testid="ready"]')?.textContent).toBe(
      "false",
    );
    act(() => {
      container
        .querySelector<HTMLButtonElement>("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(
      container.querySelector('[data-testid="outcome"]')?.textContent,
    ).toBe("in-progress");
    expect(container.querySelector('[data-testid="step"]')?.textContent).toBe(
      "workspace-welcome",
    );
  });
});
