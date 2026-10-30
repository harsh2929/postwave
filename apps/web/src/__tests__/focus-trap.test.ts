// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// focus-trap backs every modal surface in the shell (offline queue, mobile
// nav drawer, header menus) but had no direct coverage. The container-focused
// case below is how dialogs actually open, and it used to leak focus.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  firstFocusable,
  focusableElements,
  trapFocus,
} from "@/lib/focus-trap";

let root: HTMLElement;

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div id="trap" tabindex="-1">${html}</div><button id="outside">outside</button>`;
  return document.getElementById("trap") as HTMLElement;
}

function tab(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    cancelable: true,
  });
}

beforeEach(() => {
  root = mount(
    `<button id="a">a</button><button id="b">b</button><button id="c">c</button>`,
  );
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("focusableElements", () => {
  it("returns tabbable descendants in document order", () => {
    expect(focusableElements(root).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("excludes disabled, hidden, aria-hidden and tabindex=-1 nodes", () => {
    root = mount(
      `<button id="a">a</button>
       <button id="d" disabled>d</button>
       <button id="h" hidden>h</button>
       <button id="ah" aria-hidden="true">ah</button>
       <button id="ti" tabindex="-1">ti</button>
       <div hidden><button id="nested">nested</button></div>
       <button id="z">z</button>`,
    );
    expect(focusableElements(root).map((e) => e.id)).toEqual(["a", "z"]);
  });

  it("returns an empty list for a null root", () => {
    expect(focusableElements(null)).toEqual([]);
  });
});

describe("firstFocusable", () => {
  it("prefers the first tabbable child", () => {
    expect(firstFocusable(root)?.id).toBe("a");
  });

  it("falls back to the container when nothing inside is tabbable", () => {
    root = mount(`<p>no controls</p>`);
    expect(firstFocusable(root)?.id).toBe("trap");
  });
});

describe("trapFocus", () => {
  it("wraps forward from the last element to the first", () => {
    document.getElementById("c")!.focus();
    const e = tab();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("wraps backward from the first element to the last", () => {
    document.getElementById("a")!.focus();
    const e = tab(true);
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("c");
  });

  it("leaves interior moves to the browser", () => {
    document.getElementById("b")!.focus();
    const e = tab();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(false);
  });

  it("pulls focus back in when it is outside the trap", () => {
    document.getElementById("outside")!.focus();
    const e = tab();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");

    document.getElementById("outside")!.focus();
    const back = tab(true);
    trapFocus(back, root);
    expect(document.activeElement?.id).toBe("c");
  });

  it("keeps focus inside when the container itself holds focus", () => {
    // How dialogs open: the tabindex="-1" container is focused, and it is
    // deliberately absent from focusableElements. Falling through here would
    // let the browser's default Tab escape to #outside.
    root.focus();
    expect(document.activeElement?.id).toBe("trap");

    const e = tab();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("wraps to the last element when shift-tabbing off the container", () => {
    root.focus();
    const e = tab(true);
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("c");
  });

  it("resumes natural order from a non-tabbable node mid-trap", () => {
    root = mount(
      `<button id="a">a</button><span id="mid" tabindex="-1">mid</span><button id="c">c</button>`,
    );
    document.getElementById("mid")!.focus();

    const fwd = tab();
    trapFocus(fwd, root);
    expect(document.activeElement?.id).toBe("c");

    document.getElementById("mid")!.focus();
    const back = tab(true);
    trapFocus(back, root);
    expect(document.activeElement?.id).toBe("a");
  });

  it("holds focus on the container when nothing inside is tabbable", () => {
    root = mount(`<p>no controls</p>`);
    const e = tab();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("trap");
  });

  it("keeps a single focusable element focused in both directions", () => {
    root = mount(`<button id="only">only</button>`);
    document.getElementById("only")!.focus();
    for (const shift of [false, true]) {
      const e = tab(shift);
      trapFocus(e, root);
      expect(e.defaultPrevented).toBe(true);
      expect(document.activeElement?.id).toBe("only");
    }
  });

  it("is a no-op for a null root", () => {
    const e = tab();
    expect(() => trapFocus(e, null)).not.toThrow();
    expect(e.defaultPrevented).toBe(false);
  });
});
