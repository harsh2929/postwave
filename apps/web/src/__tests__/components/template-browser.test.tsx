// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// TemplateBrowser is the shared chrome behind /app/sequence-templates and the
// /app/sequences/new picker, and it had NEITHER a test of its own NOR a page
// that any suite mounted — so its filter algebra, its two distinct empty
// states, and its localStorage pin round-trip were entirely unexercised.
//
// Rendered with realistic templates (three, across two categories, with
// variables and emails) rather than empty stubs: with `templates: []` the
// component takes the catalog-empty early exit and proves nothing about the
// grid.
//
// `persistInUrl={false}` for the interaction cases. Under the mocked
// next/navigation router, `router.replace` is a no-op and `useSearchParams`
// never changes, so the URL-backed state can never advance — a filter test
// written against it would pass no matter what the filter code did. The
// default persistInUrl=true path is covered separately, asserting only what is
// true there.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TemplateBrowser } from "@/components/sequences/template-browser";
import type { SequenceTemplate } from "@/lib/voice-types";

import { renderPage, unmount, clickEveryControl } from "../pages/_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/sequence-templates",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

function template(over: Partial<SequenceTemplate>): SequenceTemplate {
  return {
    id: "tpl_welcome",
    slug: "welcome-series",
    name: "Welcome series",
    description: "Three emails that introduce the brand to a new subscriber.",
    category: "Onboarding",
    length: 3,
    variables: [
      {
        key: "brand_name",
        label: "Brand name",
        description: "Shown in the greeting.",
        type: "text",
        example: "Moosewave",
        required: true,
      },
      {
        key: "docs_url",
        label: "Docs URL",
        description: "Linked from the second email.",
        type: "url",
        example: "https://example.com/docs",
        required: false,
      },
    ],
    emails: [
      {
        position: 1,
        subjectHint: "Say hello",
        bodyHint: "Introduce",
        delayHours: 0,
      },
      {
        position: 2,
        subjectHint: "Show value",
        bodyHint: "Teach",
        delayHours: 48,
      },
      { position: 3, subjectHint: "Ask", bodyHint: "Convert", delayHours: 120 },
    ],
    ...over,
  };
}

const TEMPLATES: SequenceTemplate[] = [
  template({}),
  template({
    id: "tpl_winback",
    slug: "winback",
    name: "Winback campaign",
    description: "Re-engage subscribers who have gone quiet for 90 days.",
    category: "Retention",
    length: 1,
    variables: [],
  }),
  template({
    id: "tpl_trial",
    slug: "trial-nudge",
    name: "Trial nudge",
    description: "Nudge trialists toward their first send.",
    category: "Onboarding",
    length: 2,
  }),
];

const actions = (t: SequenceTemplate) => (
  <button type="button" data-testid={`use-${t.id}`}>
    Use {t.name}
  </button>
);

function cardHeadings(container: HTMLElement): string[] {
  return [...container.querySelectorAll("h2")].map(
    (h) => h.textContent?.trim() ?? "",
  );
}

function chip(container: HTMLElement, label: string): HTMLElement {
  const el = [...container.querySelectorAll<HTMLElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`no chip labelled "${label}"`);
  return el;
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("TemplateBrowser", () => {
  it("renders one card per template with its counts, category and caller CTA", async () => {
    const { text, container, root } = await renderPage(TemplateBrowser, {
      templates: TEMPLATES,
      actions,
    });
    try {
      expect(cardHeadings(container)).toEqual([
        "Welcome series",
        "Winback campaign",
        "Trial nudge",
      ]);

      // Counts are pluralized off the template's own data, not hardcoded:
      // 3 emails / 2 variables, and the singular "1 email" / "0 variables".
      expect(text).toContain("3 emails");
      expect(text).toContain("2 variables");
      expect(text).toContain("1 email");
      expect(text).toContain("0 variables");
      expect(text).toContain("3 templates");

      // The caller's CTA is rendered inside every card.
      expect(container.querySelectorAll('[data-testid^="use-"]')).toHaveLength(
        3,
      );
      expect(
        container.querySelector('[data-testid="use-tpl_winback"]')?.textContent,
      ).toBe("Use Winback campaign");

      // Category chips are derived from the data (sorted) and prefixed by All.
      const chips = [...container.querySelectorAll<HTMLElement>("button")]
        .filter(
          (b) =>
            b.hasAttribute("aria-pressed") && !b.hasAttribute("aria-label"),
        )
        .map((b) => b.textContent?.trim());
      expect(chips).toEqual(["Favorites", "All", "Onboarding", "Retention"]);
    } finally {
      unmount(root);
    }
  });

  it("filters the grid to the picked category", async () => {
    const { container, root } = await renderPage(TemplateBrowser, {
      templates: TEMPLATES,
      actions,
      persistInUrl: false,
    });
    try {
      await act(async () => {
        chip(container, "Retention").click();
      });
      expect(cardHeadings(container)).toEqual(["Winback campaign"]);
      expect(container.textContent).toContain("1 template");
      expect(container.textContent).not.toContain("1 templates");
    } finally {
      unmount(root);
    }
  });

  it("shows the no-match empty state (not the empty-catalog copy) when a filter excludes everything", async () => {
    const { container, root } = await renderPage(TemplateBrowser, {
      templates: TEMPLATES,
      actions,
      persistInUrl: false,
      emptyCatalogMessage: "CATALOG-EMPTY-SENTINEL",
    });
    try {
      // Nothing is pinned, so Favorites-only excludes every template — but the
      // catalog is NOT empty, so the catalog copy must stay hidden. A guard
      // that checked `filtered.length` instead of `templates.length` would
      // show the sentinel here.
      await act(async () => {
        chip(container, "Favorites").click();
      });
      expect(cardHeadings(container)).toEqual([]);
      expect(container.textContent).toContain(
        "No sequence templates match your filters.",
      );
      expect(container.textContent).not.toContain("CATALOG-EMPTY-SENTINEL");

      // Clear filters brings the whole grid back.
      await act(async () => {
        chip(container, "Clear filters").click();
      });
      expect(cardHeadings(container)).toHaveLength(3);
    } finally {
      unmount(root);
    }
  });

  it("shows the empty-catalog copy, and no Clear filters button, for an empty catalog", async () => {
    const { container, root } = await renderPage(TemplateBrowser, {
      templates: [],
      actions,
      persistInUrl: false,
      emptyCatalogMessage: "No sequence templates are available yet.",
    });
    try {
      expect(container.textContent).toContain(
        "No sequence templates are available yet.",
      );
      expect(container.textContent).not.toContain("match your filters");
      expect(
        [...container.querySelectorAll("button")].some(
          (b) => b.textContent?.trim() === "Clear filters",
        ),
      ).toBe(false);
      expect(container.textContent).toContain("0 templates");
    } finally {
      unmount(root);
    }
  });

  it("pins a template, floats it to the top, and persists the pin", async () => {
    const { container, root } = await renderPage(TemplateBrowser, {
      templates: TEMPLATES,
      actions,
      persistInUrl: false,
    });
    try {
      const pin = container.querySelector<HTMLElement>(
        '[aria-label="Pin Trial nudge"]',
      );
      expect(pin).not.toBeNull();
      await act(async () => {
        pin!.click();
      });

      expect(cardHeadings(container)[0]).toBe("Trial nudge");
      expect(
        container.querySelector('[aria-label="Unpin Trial nudge"]'),
      ).not.toBeNull();
      expect(
        window.localStorage.getItem("postwave:pinned-sequence-templates"),
      ).toBe('["tpl_trial"]');
    } finally {
      unmount(root);
    }
  });

  it("hides pin affordances entirely when favorites are disabled", async () => {
    const { container, root } = await renderPage(TemplateBrowser, {
      templates: TEMPLATES,
      actions,
      persistInUrl: false,
      enableFavorites: false,
    });
    try {
      expect(container.querySelector('[aria-label^="Pin "]')).toBeNull();
      expect(
        [...container.querySelectorAll("button")].some(
          (b) => b.textContent?.trim() === "Favorites",
        ),
      ).toBe(false);
      // Order stays as given when favorites are off.
      expect(cardHeadings(container)).toEqual([
        "Welcome series",
        "Winback campaign",
        "Trial nudge",
      ]);
    } finally {
      unmount(root);
    }
  });

  it("surfaces a load error above the grid", async () => {
    const { container, root } = await renderPage(TemplateBrowser, {
      templates: TEMPLATES,
      actions,
      loadError: "upstream timed out",
    });
    try {
      expect(container.textContent).toContain(
        "Sequence templates could not be loaded: upstream timed out",
      );
      // The grid still renders whatever was cached.
      expect(cardHeadings(container)).toHaveLength(3);
    } finally {
      unmount(root);
    }
  });

  it("does not present a failed empty response as an empty catalog", async () => {
    const { container, root } = await renderPage(TemplateBrowser, {
      templates: [],
      actions,
      loadError: "upstream timed out",
      emptyCatalogMessage: "CATALOG-EMPTY-SENTINEL",
    });
    try {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Sequence templates could not be loaded",
      );
      expect(container.textContent).not.toContain("CATALOG-EMPTY-SENTINEL");
      expect(container.textContent).not.toContain("0 templates");
      expect(cardHeadings(container)).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("keeps the clear-search button outside the label so it does not also activate the input", async () => {
    const { container, root } = await renderPage(TemplateBrowser, {
      templates: TEMPLATES,
      actions,
      persistInUrl: false,
    });
    try {
      const input = container.querySelector<HTMLInputElement>("input")!;
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        setValue.call(input, "winback");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(cardHeadings(container)).toEqual(["Winback campaign"]);

      const clear = container.querySelector<HTMLElement>(
        '[aria-label="Clear search"]',
      )!;
      expect(clear).not.toBeNull();

      // The input is still labelled by the <label> …
      const label = container.querySelector("label")!;
      expect((label as HTMLLabelElement).control).toBe(input);
      expect(label.textContent).toContain("Search sequence templates");
      // … but the button is not inside it. Interactive content in a <label> is
      // invalid HTML, and the label forwards its activation to the labelled
      // control, so pressing Clear also clicked the search box.
      expect(label.contains(clear)).toBe(false);

      let forwarded = 0;
      input.addEventListener("click", () => {
        forwarded += 1;
      });
      await act(async () => {
        clear.click();
      });
      expect(forwarded).toBe(0);
      expect(input.value).toBe("");
      expect(cardHeadings(container)).toHaveLength(3);
    } finally {
      unmount(root);
    }
  });

  it("survives a sweep of every control", async () => {
    const { container, root } = await renderPage(TemplateBrowser, {
      templates: TEMPLATES,
      actions,
      persistInUrl: false,
    });
    try {
      const { clicked, failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      expect(clicked).toBeGreaterThan(6);
    } finally {
      unmount(root);
    }
  });
});
