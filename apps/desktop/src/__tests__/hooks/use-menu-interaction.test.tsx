// @vitest-environment happy-dom

import { act, type ReactElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { useMenuInteraction } from "../../hooks/useMenuInteraction";

interface HarnessProps {
  onClose: () => void;
  suspended?: boolean;
  trigger: HTMLElement;
}

function Harness({ onClose, suspended, trigger }: HarnessProps): ReactElement {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useMenuInteraction({
    menuRef,
    onClose,
    open: true,
    selectedItemSelector: '[aria-checked="true"]',
    suspended,
    trigger,
  });
  return (
    <div ref={menuRef} role="menu" aria-label="Test menu">
      <button type="button" role="menuitem" tabIndex={-1}>
        Alpha
      </button>
      <button type="button" role="menuitem" tabIndex={-1}>
        Archive
      </button>
      <button type="button" role="menuitem" tabIndex={-1} disabled>
        Beta
      </button>
      <button
        type="button"
        role="menuitemradio"
        aria-checked="true"
        tabIndex={-1}
      >
        Charlie
      </button>
    </div>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let trigger: HTMLButtonElement | null = null;

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
  trigger = document.createElement("button");
  trigger.textContent = "Trigger";
  document.body.appendChild(trigger);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  trigger = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderHarness(onClose = vi.fn(), suspended = false): () => void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <Harness
        onClose={onClose}
        suspended={suspended}
        trigger={trigger!}
      />,
    );
  });
  return onClose;
}

function press(key: string): void {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
}

describe("useMenuInteraction", () => {
  it("focuses selection and supports arrows, boundaries, and repeated typeahead", () => {
    renderHarness();
    expect(document.activeElement?.textContent).toBe("Charlie");
    press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Alpha");
    press("ArrowUp");
    expect(document.activeElement?.textContent).toBe("Charlie");
    press("Home");
    expect(document.activeElement?.textContent).toBe("Alpha");
    press("End");
    expect(document.activeElement?.textContent).toBe("Charlie");
    press("a");
    expect(document.activeElement?.textContent).toBe("Alpha");
    press("a");
    expect(document.activeElement?.textContent).toBe("Archive");
  });

  it("ignores composing Escape, then closes and restores its trigger", async () => {
    const onClose = renderHarness();
    const composing = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(composing, "isComposing", { value: true });
    act(() => {
      window.dispatchEvent(composing);
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await act(async () => Promise.resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses only an outside pointer and defers everything while suspended", () => {
    const onClose = renderHarness();
    act(() => {
      document.activeElement?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(<Harness onClose={onClose} suspended trigger={trigger!} />);
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses when programmatic focus leaves both popup and trigger", () => {
    const onClose = renderHarness();
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(outside);
  });
});
