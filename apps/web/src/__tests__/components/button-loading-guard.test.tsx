// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
/**
 * The `loading` prop is the ONLY in-flight guard on ten Buttons in this app —
 * they pass `loading={mut.isPending}` and no `disabled`, so preventing a
 * double-submit is entirely delegated to this primitive. Nothing tested that.
 *
 * This was found by mutation: removing `|| loading` from the disabled
 * expression left all 3,483 tests green. Two of those ten Buttons revoke
 * device trust, so a double-submit there is a duplicated destructive write.
 *
 * These tests target the primitive directly rather than a page, because the
 * invariant belongs to the primitive: any page that passes `loading` alone is
 * relying on exactly this behaviour.
 */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";

async function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return {
    host,
    root,
    button: () => host.querySelector("button"),
    anchor: () => host.querySelector("a"),
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("Button: loading is a real guard, not just a spinner", () => {
  it("keeps every variant at least 44px square for coarse pointers", async () => {
    const m = await mount(<Button size="sm">OK</Button>);
    try {
      expect(m.button()?.className).toContain(
        "[@media(pointer:coarse)]:min-h-11",
      );
      expect(m.button()?.className).toContain(
        "[@media(pointer:coarse)]:min-w-11",
      );
    } finally {
      m.cleanup();
    }
  });

  it("loading disables the button", async () => {
    const m = await mount(<Button loading>Save</Button>);
    try {
      expect(m.button()!.disabled).toBe(true);
    } finally {
      m.cleanup();
    }
  });

  it("a click while loading does not reach onClick", async () => {
    const onClick = vi.fn();
    const m = await mount(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    try {
      // Asserting on the HANDLER, not on the disabled attribute: `disabled`
      // is the mechanism, "the write does not fire twice" is the property.
      // A future refactor could keep the attribute and still leak the click
      // through (e.g. by moving the handler onto a wrapper).
      await act(async () => {
        m.button()!.click();
      });
      expect(onClick).not.toHaveBeenCalled();
    } finally {
      m.cleanup();
    }
  });

  it("the same button DOES fire once loading clears", async () => {
    // Without this, "never fires" would pass a permanently dead button.
    const onClick = vi.fn();
    const m = await mount(
      <Button loading={false} onClick={onClick}>
        Save
      </Button>,
    );
    try {
      await act(async () => {
        m.button()!.click();
      });
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(m.button()!.disabled).toBe(false);
    } finally {
      m.cleanup();
    }
  });

  it("loading sets aria-busy, so the state is announced and not merely drawn", async () => {
    const m = await mount(<Button loading>Save</Button>);
    try {
      expect(m.button()!.getAttribute("aria-busy")).toBe("true");
    } finally {
      m.cleanup();
    }
  });

  it("aria-busy is absent when idle rather than 'false'", async () => {
    const m = await mount(<Button>Save</Button>);
    try {
      // The component writes `showSpinner || undefined` specifically so the
      // attribute is omitted; aria-busy="false" is a different announcement.
      expect(m.button()!.hasAttribute("aria-busy")).toBe(false);
    } finally {
      m.cleanup();
    }
  });

  it("an explicit disabled still wins when not loading", async () => {
    const m = await mount(<Button disabled>Save</Button>);
    try {
      expect(m.button()!.disabled).toBe(true);
    } finally {
      m.cleanup();
    }
  });

  it("loading also guards an asChild link without injecting a second child", async () => {
    const m = await mount(
      <Button asChild loading>
        <a href="https://example.com/somewhere">Go</a>
      </Button>,
    );
    try {
      expect(m.anchor()).not.toBeNull();
      expect(m.anchor()!.getAttribute("aria-busy")).toBe("true");
      expect(m.anchor()!.getAttribute("aria-disabled")).toBe("true");
      expect(m.anchor()!.tabIndex).toBe(-1);
      expect(m.host.querySelector(".animate-spin")).toBeNull();
    } finally {
      m.cleanup();
    }
  });

  it("a disabled asChild link cannot navigate or leak its child handler", async () => {
    const childClick = vi.fn();
    const wrapperClick = vi.fn();
    const m = await mount(
      <Button asChild disabled onClick={wrapperClick}>
        <a href="#should-not-open" onClick={childClick}>
          Go
        </a>
      </Button>,
    );
    try {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      const allowed = m.anchor()!.dispatchEvent(event);

      expect(allowed).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(childClick).not.toHaveBeenCalled();
      expect(wrapperClick).not.toHaveBeenCalled();
      expect(window.location.hash).toBe("");
      expect(m.anchor()!.hasAttribute("disabled")).toBe(false);
    } finally {
      m.cleanup();
    }
  });

  it("an enabled asChild link keeps its child and wrapper activation", async () => {
    const childClick = vi.fn((event: React.MouseEvent) =>
      event.preventDefault(),
    );
    const wrapperClick = vi.fn();
    const m = await mount(
      <Button asChild onClick={wrapperClick}>
        <a href="#enabled" onClick={childClick}>
          Go
        </a>
      </Button>,
    );
    try {
      m.anchor()!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      expect(childClick).toHaveBeenCalledTimes(1);
      expect(wrapperClick).toHaveBeenCalledTimes(1);
      expect(m.anchor()!.hasAttribute("aria-disabled")).toBe(false);
    } finally {
      m.cleanup();
    }
  });
});
