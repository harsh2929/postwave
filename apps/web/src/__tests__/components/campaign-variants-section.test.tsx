// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CampaignVariantsSection } from "@/app/(dashboard)/app/campaigns/[id]/campaign-variants-section";
import type { CampaignVariant } from "@/app/(dashboard)/app/campaigns/[id]/campaign-detail-helpers";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
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

function inputById(id: string): HTMLInputElement {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found: ${id}`);
  return input;
}

function textareaById(id: string): HTMLTextAreaElement {
  const textarea = document.getElementById(id);
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error(`Textarea not found: ${id}`);
  return textarea;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
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

function renderSection(
  variants: CampaignVariant[],
  onChange: (variants: CampaignVariant[]) => void,
): Root {
  return render(
    createElement(CampaignVariantsSection, {
      campaignBodyHtml: "<p>Base</p>",
      campaignPreviewText: "Preview",
      campaignSubject: "Launch subject",
      onChange,
      variants,
    }),
  );
}

describe("CampaignVariantsSection", () => {
  it("adds a default variant from the current campaign draft", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234567890);
    const onChange = vi.fn<(variants: CampaignVariant[]) => void>();
    const root = renderSection([], onChange);

    try {
      expect(document.body.textContent).toContain(
        "Add variants to bind A/B content directly to this campaign draft.",
      );

      act(() => {
        buttonByText("Add variant").click();
      });

      expect(onChange).toHaveBeenCalledWith([
        {
          id: "variant-1234567890",
          name: "Variant 1",
          subject: "Launch subject",
          preview_text: "Preview",
          body_html: "<p>Base</p>",
          weight: 100,
        },
      ]);
    } finally {
      act(() => root.unmount());
    }
  });

  it("merges edits into the selected variant", () => {
    const variants: CampaignVariant[] = [
      {
        id: "a",
        name: "Original",
        subject: "Subject A",
        preview_text: "Preview A",
        body_html: "<p>A</p>",
        weight: 40,
      },
      {
        id: "b",
        name: "Variant B",
        subject: "Subject B",
        preserved: true,
        weight: 60,
      },
    ];
    const onChange = vi.fn<(variants: CampaignVariant[]) => void>();
    const root = renderSection(variants, onChange);

    try {
      act(() => {
        changeInput(inputById("variant-name-1"), "Winner");
      });

      expect(onChange).toHaveBeenLastCalledWith([
        variants[0],
        {
          ...variants[1],
          name: "Winner",
        },
      ]);

      act(() => {
        changeInput(inputById("variant-weight-1"), "75");
      });
      expect(onChange).toHaveBeenLastCalledWith([
        variants[0],
        {
          ...variants[1],
          weight: 75,
        },
      ]);

      act(() => {
        changeTextarea(textareaById("variant-html-1"), "<p>Winner</p>");
      });
      expect(onChange).toHaveBeenLastCalledWith([
        variants[0],
        {
          ...variants[1],
          body_html: "<p>Winner</p>",
        },
      ]);
    } finally {
      act(() => root.unmount());
    }
  });

  it("removes the requested variant without touching the others", () => {
    const variants: CampaignVariant[] = [
      { id: "a", name: "Variant A" },
      { id: "b", name: "Variant B" },
      { id: "c", name: "Variant C" },
    ];
    const onChange = vi.fn<(variants: CampaignVariant[]) => void>();
    const root = renderSection(variants, onChange);

    try {
      const removeButtons = Array.from(
        document.querySelectorAll("button[aria-label^='Remove variant']"),
      );
      act(() => {
        (removeButtons[1] as HTMLButtonElement).click();
      });

      expect(onChange).toHaveBeenCalledWith([variants[0], variants[2]]);
    } finally {
      act(() => root.unmount());
    }
  });
});
