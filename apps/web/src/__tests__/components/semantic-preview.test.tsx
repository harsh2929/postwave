// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Render coverage for SemanticPreview.
//
// WHY THIS FILE EXISTS, given the component is already executed by
// semantic-block-editor.test.tsx. That suite asserts two things about the
// preview — the iframe's sandbox attribute and the plain-text projection of a
// paragraph. Two behaviours it runs through but never checks are the ones a
// regression would actually hide:
//
//   1. FAIL-CLOSED. When compilation reports an error the pane must say so and
//      show NOTHING, because a preview built from a document the server would
//      reject is a preview of an email nobody will receive.
//   2. The `slots` prop reaching the compiler. If it were dropped, every
//      preview would silently render fallbacks — which looks like a working
//      preview, and is the state a recipient with no data receives, not the
//      scenario the author asked to see.
import { act } from "react";
import { describe, expect, it } from "vitest";

import { SemanticPreview } from "@/components/semantic-email/semantic-preview";
import { createNode } from "@/lib/semantic-email/authoring";
import type { SemanticNode } from "@/lib/semantic-email/types";

import { renderPage, unmount } from "../pages/_harness";

function tab(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((candidate) => candidate.textContent === label);
  expect(found, `tab "${label}"`).toBeDefined();
  return found!;
}

async function pressTab(target: HTMLButtonElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function personalization(fallback: string): SemanticNode {
  const node = createNode("personalization", "1");
  node.content.personalization!.slot.fallback = fallback;
  return node;
}

describe("semantic preview", () => {
  it("names its projection tabs and supports the full roving keyboard pattern", async () => {
    const { container, root } = await renderPage(SemanticPreview, {
      nodes: [createNode("paragraph", "1")],
      slots: {},
    });
    try {
      const list = container.querySelector('[role="tablist"]');
      const html = tab(container, "HTML");
      const text = tab(container, "Plain text");

      expect(
        [...container.querySelectorAll('[role="tab"]')].map((item) =>
          item.textContent?.trim(),
        ),
      ).toEqual(["HTML", "Plain text"]);
      expect(list?.getAttribute("aria-label")).toBe("Projection");
      expect((list as HTMLElement | null)?.tabIndex).toBe(0);
      expect([html.tabIndex, text.tabIndex]).toEqual([-1, -1]);
      await act(async () => {
        html.focus();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect([html.tabIndex, text.tabIndex]).toEqual([0, -1]);

      await pressTab(html, "ArrowRight");
      expect(document.activeElement).toBe(text);
      expect(text.getAttribute("aria-selected")).toBe("true");

      await pressTab(text, "Home");
      expect(document.activeElement).toBe(html);
      expect(html.getAttribute("aria-selected")).toBe("true");

      await pressTab(html, "End");
      expect(document.activeElement).toBe(text);
      expect(text.getAttribute("aria-selected")).toBe("true");
      expect(text.getAttribute("aria-controls")).toBe(
        container.querySelector('[role="tabpanel"][data-state="active"]')?.id,
      );
    } finally {
      unmount(root);
    }
  });

  it("shows both projections of the same compile, one tab at a time", async () => {
    const { text, container, root } = await renderPage(SemanticPreview, {
      nodes: [createNode("paragraph", "1")],
      slots: {},
    });
    try {
      expect(text).toContain("Preview");

      // HTML is the landing tab, and it is sandboxed with no flags: no
      // scripts, no same-origin, for a document the author has not sent yet.
      expect(tab(container, "HTML").getAttribute("aria-selected")).toBe("true");
      expect(tab(container, "Plain text").getAttribute("aria-selected")).toBe(
        "false",
      );
      const frame = container.querySelector("iframe");
      expect(frame).not.toBeNull();
      expect(frame!.getAttribute("sandbox")).toBe("");
      expect(frame!.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(frame!.getAttribute("title")).toBe(
        "Semantic email HTML projection",
      );
      expect(frame!.getAttribute("srcdoc")).toContain("Body copy.");
      expect(container.querySelector("pre")).toBeNull();

      // The plain-text half is the one parsers and summarisers read, so it is
      // a peer of the HTML rather than a developer affordance.
      await act(async () => {
        tab(container, "Plain text").click();
      });
      expect(tab(container, "Plain text").getAttribute("aria-selected")).toBe(
        "true",
      );
      expect(tab(container, "HTML").getAttribute("aria-selected")).toBe(
        "false",
      );
      expect(container.querySelector("pre")!.textContent).toBe("Body copy.\n");
      expect(container.querySelector("iframe")).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("resolves personalization against the fixture values it is given", async () => {
    const { container, root } = await renderPage(SemanticPreview, {
      nodes: [personalization("there")],
      slots: { first_name: "Ada" },
    });
    try {
      const srcdoc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
      expect(srcdoc).toContain("Ada");
      expect(srcdoc).not.toContain("there");
    } finally {
      unmount(root);
    }
  });

  it("falls back to the fallback when no fixture value is supplied", async () => {
    // Same tree, no slots: this is what a recipient with no data receives, and
    // it must be distinguishable from the scenario above rather than identical.
    const { container, root } = await renderPage(SemanticPreview, {
      nodes: [personalization("there")],
      slots: {},
    });
    try {
      const srcdoc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
      expect(srcdoc).toContain("there");
      expect(srcdoc).not.toContain("Ada");
    } finally {
      unmount(root);
    }
  });

  it("shows nothing at all when the document does not compile", async () => {
    // Compilation fails closed rather than guessing: an unresolved condition
    // or a required slot with no fallback has no single right answer, so a
    // partial preview would be a confident lie.
    const { text, container, root } = await renderPage(SemanticPreview, {
      nodes: [],
      slots: {},
    });
    try {
      expect(text).toContain("Nothing to preview: 1 error(s)");
      expect(container.querySelector("iframe")).toBeNull();
      expect(container.querySelector("pre")).toBeNull();

      // The tabs stay operable, and selecting plain text must not smuggle the
      // uncompiled projection in through the other branch.
      await act(async () => {
        tab(container, "Plain text").click();
      });
      expect(container.querySelector("pre")).toBeNull();
      expect(container.textContent).toContain("Nothing to preview");
    } finally {
      unmount(root);
    }
  });
});
