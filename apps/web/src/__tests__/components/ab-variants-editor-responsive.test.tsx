// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AbVariantsEditor } from "@/components/campaigns/ab-variants-editor";
import type { Variant } from "@/lib/abtests-types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

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

describe("AbVariantsEditor responsive action rows", () => {
  it("stacks a bounded mobile action grid while retaining compact desktop controls", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(AbVariantsEditor, {
          initial: variants,
          onChange: vi.fn(),
        }),
      );
    });

    const actionGroups = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="group"][aria-label^="Actions for variant"]',
      ),
    );
    expect(actionGroups).toHaveLength(2);

    actionGroups.forEach((group, index) => {
      const label = variants[index]?.variant_label;
      const header = group.parentElement;
      expect(header?.classList.contains("flex-col")).toBe(true);
      expect(header?.classList.contains("sm:flex-row")).toBe(true);

      expect(group.classList.contains("grid")).toBe(true);
      expect(group.classList.contains("w-full")).toBe(true);
      expect(
        group.classList.contains("grid-cols-[minmax(0,1fr)_repeat(3,2.75rem)]"),
      ).toBe(true);
      expect(group.classList.contains("sm:flex")).toBe(true);
      expect(group.classList.contains("sm:w-auto")).toBe(true);

      const controls = Array.from(
        group.querySelectorAll<HTMLButtonElement>("button"),
      );
      expect(
        controls.map((control) => control.getAttribute("aria-label")),
      ).toEqual([
        `Preview variant ${label}`,
        `Send a test of variant ${label}`,
        `Duplicate variant ${label}`,
        `Remove variant ${label}`,
      ]);

      controls.forEach((control) => {
        expect(control.classList.contains("min-h-11")).toBe(true);
        expect(control.classList.contains("sm:min-h-0")).toBe(true);
      });
      controls.slice(1).forEach((control) => {
        expect(control.classList.contains("min-w-11")).toBe(true);
        expect(control.classList.contains("sm:min-w-0")).toBe(true);
      });
    });
  });
});
