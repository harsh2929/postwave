// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AbVariantsEditor } from "@/components/campaigns/ab-variants-editor";
import { Slider } from "@/components/ui/slider";
import type { Variant } from "@/lib/abtests-types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function render(ui: ReactNode): void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(ui));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Slider accessibility", () => {
  it("keeps a 44px input hit box around a slim cross-browser track", () => {
    render(
      createElement(Slider, {
        label: "Directness",
        value: 0,
        onChange: vi.fn(),
      }),
    );

    const range = document.querySelector<HTMLInputElement>(
      'input[type="range"]',
    );
    expect(range).not.toBeNull();
    expect(range?.classList.contains("h-11")).toBe(true);
    expect(range?.classList.contains("h-1.5")).toBe(false);
    expect(range?.className).toContain(
      "[&::-webkit-slider-runnable-track]:h-1.5",
    );
    expect(range?.className).toContain("[&::-moz-range-track]:h-1.5");
    expect(range?.className).toContain("[&::-webkit-slider-thumb]:h-5");
    expect(range?.className).toContain("[&::-moz-range-thumb]:h-5");
    expect(range?.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("gives every campaign variant weight control a distinct name", () => {
    const variants: Variant[] = [
      {
        variant_label: "A",
        subject: "Control",
        from_name: "Moosewave",
        from_email: "hello@example.test",
        body_mjml: "<mjml />",
        weight: 50,
      },
      {
        variant_label: "B",
        subject: "Challenger",
        from_name: "Moosewave",
        from_email: "hello@example.test",
        body_mjml: "<mjml />",
        weight: 50,
      },
    ];

    render(
      createElement(AbVariantsEditor, {
        initial: variants,
        onChange: vi.fn(),
      }),
    );

    const ranges = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="range"]'),
    );
    expect(ranges).toHaveLength(2);
    expect(ranges.map((range) => range.getAttribute("aria-label"))).toEqual([
      "Weight for variant A",
      "Weight for variant B",
    ]);
  });
});
