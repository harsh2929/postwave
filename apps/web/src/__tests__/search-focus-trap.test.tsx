// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The docs ⌘K dialog trapped Tab by comparing document.activeElement against
// the first and last focusable element in the panel. Clicking dead space
// inside the panel moves focus to <body>, which matches neither, so nothing
// called preventDefault and the next Tab walked out of the modal into the
// page behind it.
//
// lib/focus-trap.ts already solved this — its own comment describes the exact
// failure — so the fix was to delegate rather than re-derive. This asserts the
// behaviour at the level the bug lives: focus parked outside the focusable
// set, Tab pressed, trap must intervene.
import { describe, expect, it } from "vitest";

import { trapFocus } from "@/lib/focus-trap";

function buildPanel(): { root: HTMLElement; dead: HTMLElement } {
  document.body.innerHTML = `
    <button id="outside">outside the dialog</button>
    <div id="panel">
      <div id="dead">not focusable</div>
      <input id="q" />
      <a href="#one">one</a>
      <a href="#two">two</a>
    </div>`;
  return {
    root: document.getElementById("panel")!,
    dead: document.getElementById("dead")!,
  };
}

function pressTab(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
}

describe("docs search dialog focus trap", () => {
  it("intervenes when focus sits outside the focusable set", () => {
    const { root } = buildPanel();
    // Clicking a non-focusable region leaves activeElement on <body>.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    const event = pressTab();
    trapFocus(event, root);

    // The old hand-rolled check did nothing here — that was the escape.
    expect(event.defaultPrevented).toBe(true);
    expect(root.contains(document.activeElement)).toBe(true);
  });

  it("wraps from the last focusable back to the first", () => {
    const { root } = buildPanel();
    const last = root.querySelector<HTMLElement>('a[href="#two"]')!;
    last.focus();

    const event = pressTab();
    trapFocus(event, root);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(root.querySelector("#q"));
  });

  it("wraps backwards from the first focusable to the last", () => {
    const { root } = buildPanel();
    const first = root.querySelector<HTMLElement>("#q")!;
    first.focus();

    const event = pressTab(true);
    trapFocus(event, root);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(
      root.querySelector('a[href="#two"]'),
    );
  });

  it("never lets Tab land on an element outside the dialog", () => {
    const { root } = buildPanel();
    const outside = document.getElementById("outside")!;
    for (const start of [null, root.querySelector<HTMLElement>("#q")]) {
      if (start) {
        start.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur();
      }
      const event = pressTab();
      trapFocus(event, root);
      expect(document.activeElement).not.toBe(outside);
    }
  });
});
