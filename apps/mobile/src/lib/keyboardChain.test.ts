import { describe, expect, it, vi } from "vitest";

import {
  keyboardChain,
  keyboardDismiss,
  type FocusableRef,
} from "./keyboardChain";

function refTo(focus: () => void): FocusableRef {
  return { current: { focus } };
}

describe("keyboardChain", () => {
  it("a field with nothing to do keeps the platform default", () => {
    expect(keyboardChain({})).toEqual({});
    expect(keyboardChain({ multiline: true })).toEqual({});
  });

  it("still renders an explicit key cap with no action wired", () => {
    expect(keyboardChain({ returnKeyType: "search" })).toEqual({
      returnKeyType: "search",
    });
  });

  it("a field with a sibling shows 'next' and moves focus to it", () => {
    const focus = vi.fn();
    const props = keyboardChain({ next: refTo(focus) });
    expect(props.returnKeyType).toBe("next");
    props.onSubmitEditing?.();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("keeps the keyboard up while advancing (no dismiss/re-raise bounce)", () => {
    expect(keyboardChain({ next: refTo(() => {}) }).submitBehavior).toBe(
      "submit",
    );
  });

  it("a terminal field shows 'go' and blurs after submitting", () => {
    const submit = vi.fn();
    const props = keyboardChain({ onSubmit: submit });
    expect(props.returnKeyType).toBe("go");
    expect(props.submitBehavior).toBe("blurAndSubmit");
    props.onSubmitEditing?.();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("advancing wins over submitting — a middle field never submits", () => {
    const focus = vi.fn();
    const submit = vi.fn();
    const props = keyboardChain({ next: refTo(focus), onSubmit: submit });
    expect(props.returnKeyType).toBe("next");
    props.onSubmitEditing?.();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("a multiline field is submittable — the default would swallow return", () => {
    // RN's multiline default is "newline", which means onSubmitEditing never
    // fires. Whatever we return must therefore be an explicit behaviour.
    const props = keyboardChain({ onSubmit: () => {}, multiline: true });
    expect(props.submitBehavior).toBeDefined();
    expect(props.submitBehavior).not.toBe("newline");
  });

  it("an unfocusable ref does not throw on return", () => {
    const props = keyboardChain({ next: { current: null } });
    expect(() => props.onSubmitEditing?.()).not.toThrow();
  });

  it("a disabled terminal field keeps its key cap but wires no action", () => {
    const submit = vi.fn();
    const props = keyboardChain({ onSubmit: submit, disabled: true });
    expect(props.returnKeyType).toBe("go");
    expect(props.onSubmitEditing).toBeUndefined();
  });

  it("omits absent keys rather than setting them undefined", () => {
    // exactOptionalPropertyTypes is on, and an explicit `undefined` would
    // override a `{...rest}` spread on the same element.
    expect(Object.keys(keyboardChain({}))).toEqual([]);
    expect(Object.keys(keyboardChain({ next: refTo(() => {}) })).sort()).toEqual(
      ["onSubmitEditing", "returnKeyType", "submitBehavior"],
    );
  });

  it("keyboardDismiss says 'done', never 'go'", () => {
    // "go" promises a submit; a lone field whose form is submitted by a
    // button has none, and saying so would be a lie about what return does.
    expect(keyboardDismiss()).toEqual({
      returnKeyType: "done",
      submitBehavior: "blurAndSubmit",
    });
  });
});
