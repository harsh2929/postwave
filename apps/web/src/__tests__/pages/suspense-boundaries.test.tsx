// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// renderPage's Suspense wait (./_harness.tsx). A page that loads a section
// with React.lazy usually shows a bare skeleton meanwhile: no role, no text,
// nothing a DOM check can tell from a settled page. renderPage used to return
// with that section's chunk still in flight, and when the chunk landed after
// the test React logged "A suspended resource finished loading" into a later
// test, or after the file had finished, which failed the run. These tests pin
// the wait that replaced it and the fiber walk it relies on.

import {
  act,
  createElement,
  lazy,
  Suspense,
  type ComponentType,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { renderPage, suspendedBoundaries, unmount } from "./_harness";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) unmount(root);
  document.body.innerHTML = "";
});

function mount(ui: ReturnType<typeof createElement>): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(ui);
  });
  return root;
}

/** A lazy section and the function that lands its chunk. */
function deferredSection(text: string) {
  let land!: () => void;
  const Section = lazy(
    () =>
      new Promise<{ default: ComponentType }>((resolve) => {
        land = () => resolve({ default: () => createElement("p", null, text) });
      }),
  );
  return { Section, land: () => land() };
}

/** A lazy section whose chunk lands on its own after `ms`. */
function sectionLandingAfter(ms: number, text: string) {
  return lazy(
    () =>
      new Promise<{ default: ComponentType }>((resolve) => {
        setTimeout(
          () => resolve({ default: () => createElement("p", null, text) }),
          ms,
        );
      }),
  );
}

const HEADING =
  "A page with a lazily loaded section, and enough text to count as rendered";

// The fallback these pages really use: a bare skeleton with no role or text.
const skeleton = () =>
  createElement("div", { "data-testid": "skeleton", className: "h-32" });

describe("suspendedBoundaries", () => {
  it("counts a boundary while its lazy section loads, and none once it lands", async () => {
    const { Section, land } = deferredSection("section arrived");
    const root = mount(
      createElement(Suspense, { fallback: skeleton() }, createElement(Section)),
    );
    expect(document.querySelector('[data-testid="skeleton"]')).not.toBeNull();
    expect(suspendedBoundaries(root)).toBe(1);

    await act(async () => {
      land();
    });

    expect(document.body.textContent).toContain("section arrived");
    expect(suspendedBoundaries(root)).toBe(0);
  });

  it("counts every suspended boundary, nested ones included", async () => {
    const outer = deferredSection("outer arrived");
    const inner = deferredSection("inner arrived");
    const sibling = deferredSection("sibling arrived");
    const root = mount(
      createElement(
        "div",
        null,
        createElement(
          Suspense,
          { fallback: skeleton() },
          createElement(outer.Section),
          createElement(
            Suspense,
            { fallback: skeleton() },
            createElement(inner.Section),
          ),
        ),
        createElement(
          Suspense,
          { fallback: skeleton() },
          createElement(sibling.Section),
        ),
      ),
    );
    // The outer boundary hides its nested one until outer lands.
    expect(suspendedBoundaries(root)).toBe(2);

    await act(async () => {
      outer.land();
    });
    expect(suspendedBoundaries(root)).toBe(2);

    await act(async () => {
      inner.land();
      sibling.land();
    });
    expect(suspendedBoundaries(root)).toBe(0);
  });

  it("reports nothing for an unmounted root", () => {
    const { Section } = deferredSection("never");
    const root = mount(
      createElement(Suspense, { fallback: skeleton() }, createElement(Section)),
    );
    expect(suspendedBoundaries(root)).toBe(1);
    unmount(root);
    expect(suspendedBoundaries(root)).toBe(0);
  });

  it("throws, rather than reporting zero, when React's internals are not where it looks", () => {
    expect(() => suspendedBoundaries({} as Root)).toThrow(
      /no longer exposes root\._internalRoot\.current/,
    );
  });
});

describe("renderPage", () => {
  it("waits for a lazy section whose fallback is a bare skeleton", async () => {
    const Late = sectionLandingAfter(300, "late section arrived");
    function Page() {
      return createElement(
        "main",
        null,
        createElement("h1", null, HEADING),
        createElement(Suspense, { fallback: skeleton() }, createElement(Late)),
      );
    }

    const { text, container, root } = await renderPage(Page);
    roots.push(root);

    expect(text).toContain("late section arrived");
    expect(container.querySelector('[data-testid="skeleton"]')).toBeNull();
    expect(suspendedBoundaries(root)).toBe(0);
  });

  it("fails loudly, inside the test's time and without leaving its root mounted, when a section never lands", { timeout: 2_000 }, async () => {
    const Never = lazy(
      () => new Promise<{ default: ComponentType }>(() => undefined),
    );
    function Page() {
      return createElement(
        "main",
        null,
        createElement("h1", null, HEADING),
        createElement(Suspense, { fallback: skeleton() }, createElement(Never)),
      );
    }

    const startedAt = Date.now();
    let failure: unknown;
    try {
      await renderPage(Page);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /^renderPage: 1 Suspense boundary was still showing a fallback after \d+ ms\. A lazily loaded section never arrived\.$/,
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // The root renderPage made was unmounted before it threw.
    expect(document.querySelector('[data-testid="skeleton"]')).toBeNull();
    expect(document.body.textContent).not.toContain(HEADING);
  });
});
