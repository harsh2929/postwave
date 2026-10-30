// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// FaqAccordion is rendered by the marketing pricing/FAQ surfaces, but no test
// mounted it and no page-level test reaches it, so nothing exercised the
// expand/collapse state machine, the "Expand all" pivot, or the ARIA wiring
// the deep-link feature depends on.
//
// The falsifiable claims here:
//   - one trigger and one panel per item, panels present-but-hidden when
//     collapsed (the component deliberately keeps answers in the DOM for
//     crawlers/JSON-LD — dropping them would silently break that contract)
//   - each panel is named by its own trigger (aria-labelledby), which is what
//     stops N anonymous landmarks appearing in the rotor
//   - "Expand all" flips every panel AND relabels itself to "Collapse all"
//   - toggling one question does not toggle the others
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { renderPage, unmount } from "../pages/_harness";

const ITEMS = [
  {
    question: "Do you charge per contact or per send?",
    answer: "Per send. Contacts are unlimited on every plan.",
  },
  {
    question: "Can I import from Mailchimp?",
    answer: "Yes — the migration wizard reads a Mailchimp export directly.",
  },
  {
    question: "Is there a free tier?",
    answer: "There is a free tier capped at 2,000 sends a month.",
  },
];

afterEach(() => {
  document.body.innerHTML = "";
  window.location.hash = "";
});

function triggers(container: HTMLElement): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>("button[aria-controls]"),
  ];
}

function panels(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[role='region']")];
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("FaqAccordion", () => {
  it("renders a trigger and a hidden-but-present panel per item", async () => {
    const { FaqAccordion } = await import(
      "@/components/marketing/faq-accordion"
    );
    const { container, root } = await renderPage(FaqAccordion, {
      items: ITEMS,
    });
    try {
      const qs = triggers(container);
      expect(qs.length).toBe(ITEMS.length);
      expect(qs.map((b) => b.textContent)).toEqual(
        ITEMS.map((i) => `${i.question}+`),
      );

      const ps = panels(container);
      expect(ps.length).toBe(ITEMS.length);
      for (const [i, panel] of ps.entries()) {
        // Answers stay in the DOM when collapsed — the crawler/JSON-LD
        // contract. `hidden` is what conveys the collapsed state.
        expect(panel.textContent).toBe(ITEMS[i]!.answer);
        expect(panel.hasAttribute("hidden")).toBe(true);
        // Every panel is named by its own trigger.
        expect(panel.getAttribute("aria-labelledby")).toBe(qs[i]!.id);
        expect(qs[i]!.getAttribute("aria-controls")).toBe(panel.id);
        expect(qs[i]!.getAttribute("aria-expanded")).toBe("false");
      }
      // Distinct ids — a collision would silently re-point two panels at one
      // trigger.
      expect(new Set(ps.map((p) => p.id)).size).toBe(ITEMS.length);
    } finally {
      unmount(root);
    }
  });

  it("expands only the question that was clicked", async () => {
    const { FaqAccordion } = await import(
      "@/components/marketing/faq-accordion"
    );
    const { container, root } = await renderPage(FaqAccordion, {
      items: ITEMS,
    });
    try {
      await click(triggers(container)[1]!);

      const open = panels(container).map((p) => !p.hasAttribute("hidden"));
      expect(open).toEqual([false, true, false]);
      expect(
        triggers(container).map((b) => b.getAttribute("aria-expanded")),
      ).toEqual(["false", "true", "false"]);

      // …and clicking it again collapses it.
      await click(triggers(container)[1]!);
      expect(
        panels(container).map((p) => !p.hasAttribute("hidden")),
      ).toEqual([false, false, false]);
    } finally {
      unmount(root);
    }
  });

  it("Expand all opens every panel and becomes Collapse all", async () => {
    const { FaqAccordion } = await import(
      "@/components/marketing/faq-accordion"
    );
    const { container, root } = await renderPage(FaqAccordion, {
      items: ITEMS,
    });
    try {
      // The bulk control is the one button that controls nothing specific.
      const all = [...container.querySelectorAll("button")].find(
        (b) => !b.hasAttribute("aria-controls"),
      );
      expect(all?.textContent).toBe("Expand all");
      expect(all?.getAttribute("aria-expanded")).toBe("false");

      await click(all!);

      expect(panels(container).every((p) => !p.hasAttribute("hidden"))).toBe(
        true,
      );
      expect(all?.textContent).toBe("Collapse all");
      expect(all?.getAttribute("aria-expanded")).toBe("true");

      await click(all!);
      expect(panels(container).every((p) => p.hasAttribute("hidden"))).toBe(
        true,
      );
      expect(all?.textContent).toBe("Expand all");
    } finally {
      unmount(root);
    }
  });

  it("auto-opens the panel targeted by the URL hash", async () => {
    // The deep-link feature this component exists for: a shared
    // #faq-<slug> link must land with that answer already expanded.
    window.location.hash = "#faq-is-there-a-free-tier";
    const { FaqAccordion } = await import(
      "@/components/marketing/faq-accordion"
    );
    const { container, root } = await renderPage(FaqAccordion, {
      items: ITEMS,
    });
    try {
      expect(panels(container).map((p) => !p.hasAttribute("hidden"))).toEqual([
        false,
        false,
        true,
      ]);
    } finally {
      unmount(root);
    }
  });
});
