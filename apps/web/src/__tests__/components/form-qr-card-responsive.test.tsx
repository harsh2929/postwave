// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { FormQrCard } from "@/components/forms/form-qr-card";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("form QR card narrow-screen layout", () => {
  it("stacks before the QR and actions can force page-level overflow", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <FormQrCard
          url="https://forms.example.test/forms/a-long-hosted-form-slug"
          filenameBase="a-long-hosted-form-slug"
        />,
      );
    });

    const card = container.querySelector<HTMLElement>(
      '[data-slot="form-qr-card"]',
    );
    const layout = container.querySelector<HTMLElement>(
      '[data-slot="form-qr-layout"]',
    );
    const actions = container.querySelector<HTMLElement>(
      '[data-slot="form-qr-actions"]',
    );

    expect(card?.classList.contains("min-w-0")).toBe(true);
    expect(layout?.classList.contains("min-w-0")).toBe(true);
    expect(layout?.classList.contains("flex-col")).toBe(true);
    expect(layout?.classList.contains("sm:flex-row")).toBe(true);
    expect(actions?.classList.contains("min-w-0")).toBe(true);
    expect(actions?.classList.contains("flex-wrap")).toBe(true);

    const downloadButtons = Array.from(
      actions?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    expect(downloadButtons.map((button) => button.textContent?.trim())).toEqual(
      ["SVG", "PNG"],
    );
    for (const button of downloadButtons) {
      expect(button.classList.contains("min-h-11")).toBe(true);
      expect(button.classList.contains("sm:min-h-8")).toBe(true);
    }
  });
});
