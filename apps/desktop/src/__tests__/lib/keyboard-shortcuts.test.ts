import { describe, expect, it } from "vitest";

import { isModKey, isTextInputTarget } from "../../lib/keyboard-shortcuts";

// The vitest env is `node` (see vitest.config.ts), so we synthesise tiny
// DOM-ish stubs that satisfy the `instanceof HTMLElement` check inside
// the helper. We assign HTMLElement / HTMLInputElement to local classes
// that the stubs extend, then poke them onto globalThis so `instanceof`
// works the way the helper expects.
class FakeHTMLElement {
  tagName = "DIV";
  isContentEditable = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private attrs: Record<string, string> = {};
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
}
class FakeHTMLInputElement extends FakeHTMLElement {
  override tagName = "INPUT";
  type = "text";
}
class FakeHTMLTextAreaElement extends FakeHTMLElement {
  override tagName = "TEXTAREA";
}

// Inject as the globals the helper's `instanceof` checks against.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).HTMLElement = FakeHTMLElement;

function input(type = "text"): FakeHTMLInputElement {
  const el = new FakeHTMLInputElement();
  el.type = type;
  return el;
}

// The helper accepts EventTarget | null. Our fakes don't implement the
// addEventListener trio but the helper never calls them — it only does
// instanceof + property reads. Cast through unknown for the public API.
const asTarget = (el: FakeHTMLElement | null): EventTarget | null =>
  el as unknown as EventTarget | null;

describe("isTextInputTarget", () => {
  it("returns false for null", () => {
    expect(isTextInputTarget(null)).toBe(false);
  });
  it("returns true for text-like inputs", () => {
    for (const t of ["text", "search", "email", "url", "tel", "number", "password"]) {
      expect(isTextInputTarget(asTarget(input(t)))).toBe(true);
    }
  });
  it("returns false for non-text inputs", () => {
    for (const t of ["checkbox", "radio", "submit", "button", "color", "range"]) {
      expect(isTextInputTarget(asTarget(input(t)))).toBe(false);
    }
  });
  it("returns true for textarea", () => {
    expect(isTextInputTarget(asTarget(new FakeHTMLTextAreaElement()))).toBe(true);
  });
  it("returns true for contenteditable", () => {
    const el = new FakeHTMLElement();
    el.isContentEditable = true;
    expect(isTextInputTarget(asTarget(el))).toBe(true);
  });
  it("returns true for role=textbox", () => {
    const el = new FakeHTMLElement();
    el.setAttribute("role", "textbox");
    expect(isTextInputTarget(asTarget(el))).toBe(true);
  });
  it("returns false for plain div", () => {
    expect(isTextInputTarget(asTarget(new FakeHTMLElement()))).toBe(false);
  });
});

describe("isModKey", () => {
  it("true for meta", () => {
    expect(isModKey({ metaKey: true, ctrlKey: false } as KeyboardEvent)).toBe(true);
  });
  it("true for ctrl", () => {
    expect(isModKey({ metaKey: false, ctrlKey: true } as KeyboardEvent)).toBe(true);
  });
  it("false otherwise", () => {
    expect(isModKey({ metaKey: false, ctrlKey: false } as KeyboardEvent)).toBe(false);
  });
});
