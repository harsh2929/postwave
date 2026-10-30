// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The preview must not recompile — or re-navigate its iframe — once per
// keystroke (WEB-RENDER-02).
//
// Every text field in the semantic editor commits a NEW `nodes` array per
// character. Compiling from that identity ran decode + normalize + project
// synchronously on the main thread AND rewrote `srcDoc`, which forces the
// browser to tear down and re-navigate the preview document. This file pins
// the settling behaviour by counting real `compileDocument` calls across a
// burst of prop changes: without the debounce the count tracks the burst.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wraps the REAL compiler in a spy: the assertions are about how often it runs,
// so replacing it with a stub would prove nothing about the rendered preview.
vi.mock("@/lib/semantic-email/project", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/semantic-email/project")>();
  return { ...actual, compileDocument: vi.fn(actual.compileDocument) };
});

import { SemanticPreview } from "@/components/semantic-email/semantic-preview";
import { createNode, richText } from "@/lib/semantic-email/authoring";
import { compileDocument } from "@/lib/semantic-email/project";
import type { SemanticNode } from "@/lib/semantic-email/types";

const compileSpy = vi.mocked(compileDocument);

/** A fresh single-paragraph tree — new array identity, as the editor commits. */
function tree(text: string): SemanticNode[] {
  const node = createNode("paragraph", "1");
  node.content.paragraph!.text = richText(text);
  return [node];
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  compileSpy.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(nodes: SemanticNode[]): void {
  act(() => {
    root.render(
      createElement(SemanticPreview, { nodes, slots: {} }),
    );
  });
}

function srcdoc(): string {
  return container.querySelector("iframe")!.getAttribute("srcdoc")!;
}

describe("semantic preview compile settling", () => {
  it("compiles once on mount so the pane is never blank on arrival", () => {
    render(tree("Body copy."));
    expect(compileSpy).toHaveBeenCalledTimes(1);
    expect(srcdoc()).toContain("Body copy.");
  });

  it("does not recompile per keystroke, and lands on the last one typed", () => {
    render(tree("H"));
    expect(compileSpy).toHaveBeenCalledTimes(1);

    // Six characters, 50ms apart: a normal typing cadence, nowhere near the
    // 350ms settle window.
    const typed = ["He", "Hel", "Hell", "Hello", "Hello ", "Hello t"];
    for (const text of typed) {
      render(tree(text));
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }

    // Still the mount compile. The iframe therefore still holds one document
    // and has not been re-navigated six times.
    expect(compileSpy).toHaveBeenCalledTimes(1);
    expect(srcdoc()).toContain(">H<");

    act(() => {
      vi.advanceTimersByTime(350);
    });

    // Exactly one more compile for the whole burst, showing the final text —
    // not an intermediate the author has already typed past.
    expect(compileSpy).toHaveBeenCalledTimes(2);
    expect(srcdoc()).toContain("Hello t");
  });

  it("still reflects an edit that arrives on its own", () => {
    render(tree("First"));
    render(tree("Second"));
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(compileSpy).toHaveBeenCalledTimes(2);
    expect(srcdoc()).toContain("Second");
  });
});
