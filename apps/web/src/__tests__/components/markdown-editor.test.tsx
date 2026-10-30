// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// MarkdownEditor (the Tiptap "writer mode" fallback) had NEITHER a test of its
// own NOR a page that mounted it. That hid the whole surface: the null-editor
// skeleton branch, the toolbar's isActive wiring, the link dialog, and the
// Turndown round-trip that is the component's actual contract (Tiptap is
// HTML-internally; the caller only ever sees markdown).
//
// Seeded with a real markdown document rather than "" — an empty document
// gives Tiptap a single empty paragraph, and every assertion about headings,
// lists and links would then be vacuously about nothing.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownEditor } from "@/components/editor/markdown-editor";

import { clickEveryControl, renderPage, unmount } from "../pages/_harness";

const SOURCE = [
  "## Launch notes",
  "",
  "We shipped the **new** editor today.",
  "",
  "- faster paste",
  "- fewer surprises",
  "",
  "> Read the [changelog](https://example.com/changelog).",
].join("\n");

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function toolbarLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "",
  );
}

describe("MarkdownEditor", () => {
  it("renders the seeded markdown as a real document, not a skeleton", async () => {
    const { container, root } = await renderPage(MarkdownEditor, {
      initialMarkdown: SOURCE,
    });
    try {
      // The `!editor` branch renders one empty pulsing div and nothing else;
      // if we ever land there, the ProseMirror surface is absent.
      const surface = container.querySelector(".ProseMirror");
      expect(surface).not.toBeNull();

      const text = surface?.textContent ?? "";
      expect(text).toContain("Launch notes");
      expect(text).toContain("We shipped the new editor today.");
      expect(text).toContain("faster paste");

      // Block structure survived markdownToHtml -> Tiptap, so the seeding is
      // parsing markdown rather than dumping it as one text node.
      expect(surface?.querySelector("h2")?.textContent).toBe("Launch notes");
      expect(surface?.querySelectorAll("ul > li")).toHaveLength(2);
      expect(surface?.querySelector("strong")?.textContent).toBe("new");
      const link = surface?.querySelector("a");
      expect(link?.getAttribute("href")).toBe("https://example.com/changelog");
      expect(link?.getAttribute("rel")).toBe("noreferrer");
    } finally {
      unmount(root);
    }
  });

  it("gives every icon-only toolbar control an accessible name", async () => {
    const { container, root } = await renderPage(MarkdownEditor, {
      initialMarkdown: SOURCE,
    });
    try {
      expect(toolbarLabels(container)).toEqual([
        "Bold",
        "Italic",
        "Heading",
        "Bulleted list",
        "Numbered list",
        "Quote",
        "Link",
        "Undo",
        "Redo",
      ]);
    } finally {
      unmount(root);
    }
  });

  it("emits markdown — not HTML — to onChange when the document changes", async () => {
    const onChange = vi.fn();
    const { container, root } = await renderPage(MarkdownEditor, {
      initialMarkdown: SOURCE,
      onChange,
    });
    try {
      // onUpdate only fires on a transaction that changes the document, so
      // toggle a block: the caret sits in the seeded H2, and Heading turns it
      // back into a paragraph.
      const heading = container.querySelector<HTMLElement>(
        '[aria-label="Heading"]',
      );
      await act(async () => {
        heading!.click();
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(onChange).toHaveBeenCalled();
      const md = onChange.mock.calls.at(-1)?.[0] as string;
      // Serialized live from the current document, not echoed from the seed:
      // the heading we just removed must be gone from the markdown.
      expect(md).toContain("Launch notes");
      expect(md).not.toContain("## Launch notes");
      // Turndown's configured shape: "-" bullets, inline links, no tags.
      expect(md).toMatch(/^-\s+faster paste$/m);
      expect(md).toContain("[changelog](https://example.com/changelog)");
      expect(md).toContain("**new**");
      expect(md).not.toContain("<p>");
      expect(md).not.toContain("<h2>");
    } finally {
      unmount(root);
    }
  });

  it("opens the link dialog prefilled from the caret's existing href", async () => {
    const { container, root } = await renderPage(MarkdownEditor, {
      initialMarkdown: SOURCE,
    });
    try {
      const linkButton = container.querySelector<HTMLElement>(
        '[aria-label="Link"]',
      );
      await act(async () => {
        linkButton!.click();
        await new Promise((r) => setTimeout(r, 0));
      });

      // The dialog portals to document.body, not into the container.
      const dialog = document.body;
      expect(dialog.textContent).toContain("Edit link");
      const input = dialog.querySelector<HTMLInputElement>("#editor-link-url");
      expect(input).not.toBeNull();
      // No link under the caret at document start, so it defaults to the
      // scheme stub rather than to an empty box.
      expect(input!.value).toBe("https://");

      // Cancel closes it again.
      const cancel = [...dialog.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Cancel",
      );
      await act(async () => {
        cancel!.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(document.body.textContent).not.toContain("Edit link");
    } finally {
      unmount(root);
    }
  });

  it("survives a sweep of every toolbar control", async () => {
    const onChange = vi.fn();
    const { container, root } = await renderPage(MarkdownEditor, {
      initialMarkdown: SOURCE,
      onChange,
    });
    try {
      const { clicked, failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      expect(clicked).toBe(9);
      // Pressing formatting buttons must have produced markdown, i.e. the
      // handlers actually reached the editor rather than no-oping.
      expect(onChange).toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });
});
