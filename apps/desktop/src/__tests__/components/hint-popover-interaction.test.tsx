// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HintPopover } from "../../components/onboarding/HintPopover";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    bottom: 740,
    height: 16,
    left: 1000,
    right: 1016,
    top: 724,
    width: 16,
    x: 1000,
    y: 724,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(hintKey = "sending-identity.dkim"): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<HintPopover hintKey={hintKey} />));
}

function trigger(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="dialog"]',
  );
  if (!found) throw new Error("Missing hint trigger");
  return found;
}

async function flush(): Promise<void> {
  await act(async () => Promise.resolve());
}

describe("HintPopover", () => {
  it("portals a named, collision-safe dialog and passes the serious axe gate", async () => {
    render();
    const owner = trigger();
    act(() => owner.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(container?.contains(dialog)).toBe(false);
    expect(owner.getAttribute("aria-controls")).toBe(dialog?.id);
    expect(owner.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    expect(dialog?.style.position).toBe("fixed");
    expect(dialog?.style.bottom).not.toBe("");
    expect(Number.parseFloat(dialog?.style.left ?? "0")).toBeLessThan(1000);
    const result = await axe.run(dialog!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("keeps composing Escape inert and restores the trigger on real Escape", async () => {
    render();
    const owner = trigger();
    act(() => owner.click());
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(owner);
  });

  it("dismisses on an outside pointer and leaves focus where the user moved it", () => {
    render();
    const owner = trigger();
    act(() => owner.click());
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
      outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("renders no empty affordance for an unknown schema key", () => {
    render("not-a-real-hint");
    expect(document.body.querySelector("button")).toBeNull();
  });
});
