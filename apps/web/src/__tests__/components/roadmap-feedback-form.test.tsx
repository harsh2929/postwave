// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoadmapFeedbackForm } from "@/app/(marketing)/roadmap/roadmap-feedback-form";

const submitFeedback = vi.hoisted(() => vi.fn());

vi.mock("@/lib/roadmap-feedback-api", () => ({
  submitRoadmapFeedback: submitFeedback,
}));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = ["Provider delivery evidence", "Regional data controls"];

function render(): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(RoadmapFeedbackForm, {
        slug: "roadmap-feedback",
        options: OPTIONS,
      }),
    ),
  );
  return { root, container };
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${name}`);
  }
  return match;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

beforeEach(() => submitFeedback.mockReset());

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("RoadmapFeedbackForm", () => {
  it("locks a same-tick duplicate and submits the exact retained selection", async () => {
    submitFeedback.mockResolvedValue("pending-confirmation");
    const { root, container } = render();

    try {
      const email = container.querySelector<HTMLInputElement>(
        'input[type="email"]',
      );
      const select = container.querySelector<HTMLSelectElement>("select");
      expect(email?.maxLength).toBe(320);
      expect(select?.id).toBeTruthy();
      expect(
        container.querySelector(`label[for="${select?.id}"]`),
      ).not.toBeNull();
      await type(email as HTMLInputElement, "  person@example.com  ");
      await choose(select as HTMLSelectElement, OPTIONS[1] ?? "");

      const submit = button(container, "Share requirement");
      act(() => {
        submit.click();
        submit.click();
      });
      await settle();

      expect(submitFeedback).toHaveBeenCalledTimes(1);
      expect(submitFeedback).toHaveBeenCalledWith(
        "roadmap-feedback",
        "person@example.com",
        "Regional data controls",
      );
      const status = container.querySelector('[role="status"]');
      expect(status?.textContent).toContain("check your inbox");
      expect(document.activeElement).toBe(status);
      expect(container.querySelector("form")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("focuses a failure, preserves the draft, clears stale feedback on edit, and retries", async () => {
    submitFeedback
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("subscribed");
    const { root, container } = render();

    try {
      const email = container.querySelector<HTMLInputElement>(
        'input[type="email"]',
      );
      const select = container.querySelector<HTMLSelectElement>("select");
      await type(email as HTMLInputElement, "first@example.com");
      await choose(select as HTMLSelectElement, OPTIONS[1] ?? "");
      act(() => button(container, "Share requirement").click());
      await settle();

      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Your selections are still here");
      expect(document.activeElement).toBe(alert);
      expect(email?.value).toBe("first@example.com");
      expect(select?.value).toBe(OPTIONS[1]);

      await type(email as HTMLInputElement, "second@example.com");
      expect(container.querySelector('[role="alert"]')).toBeNull();
      act(() => button(container, "Share requirement").click());
      await settle();

      expect(submitFeedback).toHaveBeenCalledTimes(2);
      expect(submitFeedback).toHaveBeenLastCalledWith(
        "roadmap-feedback",
        "second@example.com",
        "Regional data controls",
      );
      const status = container.querySelector('[role="status"]');
      expect(status?.textContent).toContain("you’re subscribed");
      expect(status?.textContent).not.toContain("check your inbox");
    } finally {
      act(() => root.unmount());
    }
  });
});
