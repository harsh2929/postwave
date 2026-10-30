// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LayoutCustomizer } from "@/components/dashboard/layout-customizer";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = [
  { key: "alpha", label: "Alpha metric" },
  { key: "beta", label: "Beta metric" },
  { key: "gamma", label: "Gamma metric" },
] as const;

function render(ui: ReactNode): {
  root: Root;
  rerender: (next: ReactNode) => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    root,
    rerender: (next) => act(() => root.render(next)),
  };
}

function view(
  overrides: Partial<React.ComponentProps<typeof LayoutCustomizer>> = {},
) {
  return createElement(LayoutCustomizer, {
    items: ITEMS,
    visibleKeys: ITEMS.map((item) => item.key),
    description: "Choose the visible metrics.",
    panelLabel: "Customize metrics",
    onSave: async () => undefined,
    ...overrides,
  });
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${name}`);
  }
  return match;
}

function labelledButton(name: string): HTMLButtonElement {
  const match = document.querySelector(`button[aria-label="${name}"]`);
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`labelled button not found: ${name}`);
  }
  return match;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("LayoutCustomizer", () => {
  it("keeps the panel unavailable and explains a read-only state", () => {
    const save = vi.fn(async () => undefined);
    const { root } = render(
      view({
        disabled: true,
        disabledReason: "Viewer mode is read-only.",
        onSave: save,
      }),
    );

    try {
      expect(button("Customize").disabled).toBe(true);
      expect(document.body.textContent).toContain("Viewer mode is read-only.");
      act(() => button("Customize").click());
      expect(document.querySelector('[role="region"]')).toBeNull();
      expect(save).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("cancels without saving and restores focus to the disclosure", async () => {
    const save = vi.fn(async () => undefined);
    const { root } = render(view({ onSave: save }));

    try {
      act(() => button("Customize").click());
      const panel = document.querySelector('[role="region"]');
      expect(panel?.getAttribute("aria-label")).toBe("Customize metrics");
      act(() => button("Cancel").click());
      await flush();

      expect(document.querySelector('[role="region"]')).toBeNull();
      expect(document.activeElement).toBe(button("Customize"));
      expect(save).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("names each reorder action, announces its position, and drafts defaults", () => {
    const { root } = render(view({ visibleKeys: ["beta", "alpha"] }));

    try {
      act(() => button("Customize").click());
      const move = labelledButton("Move Beta metric down");
      expect(move.className).toContain("h-11");
      expect(move.className).toContain("w-11");
      act(() => move.click());
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        "Beta metric moved to position 2 of 3",
      );

      act(() => button("Restore defaults").click());
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        "Default order restored in this draft",
      );
      expect(
        Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
        ).every((checkbox) => checkbox.checked),
      ).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("holds the panel and locks duplicate actions until save succeeds", async () => {
    let resolveSave: (() => void) | undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { root } = render(view({ onSave: save }));

    try {
      act(() => button("Customize").click());
      const saveButton = button("Save layout");
      act(() => {
        saveButton.click();
        saveButton.click();
      });
      await flush();

      expect(save).toHaveBeenCalledTimes(1);
      expect(
        document.querySelector('[role="region"]')?.getAttribute("aria-busy"),
      ).toBe("true");
      expect(button("Cancel").disabled).toBe(true);
      expect(button("Restore defaults").disabled).toBe(true);

      await act(async () => resolveSave?.());
      await flush();
      expect(document.querySelector('[role="region"]')).toBeNull();
      expect(document.activeElement).toBe(button("Customize"));
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps a failed draft recoverable and succeeds on retry", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 503"))
      .mockResolvedValueOnce(undefined);
    const { root } = render(view({ onSave: save }));

    try {
      act(() => button("Customize").click());
      act(() => button("Save layout").click());
      await flush();

      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("HTTP 503");
      expect(document.activeElement).toBe(alert);
      expect(document.querySelector('[role="region"]')).not.toBeNull();

      act(() => button("Save layout").click());
      await flush();
      expect(save).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="region"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("protects an unknown remote layout until reload succeeds", async () => {
    const save = vi.fn(async () => undefined);
    const reload = vi.fn(async () => undefined);
    const { root, rerender } = render(
      view({ loadError: true, onReload: reload, onSave: save }),
    );

    try {
      act(() => button("Customize").click());
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "never overwritten",
      );
      expect(button("Save layout").disabled).toBe(true);

      act(() => button("Reload layout").click());
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
      rerender(
        view({
          loadError: false,
          visibleKeys: ["gamma", "alpha"],
          onReload: reload,
          onSave: save,
        }),
      );
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        "Saved layout loaded",
      );
      expect(button("Save layout").disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });
});
