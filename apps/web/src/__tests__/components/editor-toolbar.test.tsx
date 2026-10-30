// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// EditorToolbar had NEITHER a test of its own NOR any page that rendered it,
// so nothing exercised it at all: its toggle groups, its aria-live history
// announcement, and its saving-disabled Save button were unverified.
//
// Every assertion here is falsifiable. Dropping `aria-checked`, swapping the
// two ToggleGroup `value` props, forgetting to call `onUndo` before the
// announcement, or removing `disabled={saving}` each fails a named case.
import { act } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { EditorToolbar } from "@/components/editor/editor-toolbar";
import type { PreviewMode, PreviewTheme } from "@/components/editor/preview-pane";

import { clickEveryControl, renderPage, unmount } from "../pages/_harness";

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

type Handlers = {
  onSave: Mock<() => void>;
  onUndo: Mock<() => void>;
  onRedo: Mock<() => void>;
  onPreviewModeChange: Mock<(m: PreviewMode) => void>;
  onPreviewThemeChange: Mock<(t: PreviewTheme) => void>;
};

function handlers(): Handlers {
  return {
    onSave: vi.fn<() => void>(),
    onUndo: vi.fn<() => void>(),
    onRedo: vi.fn<() => void>(),
    onPreviewModeChange: vi.fn<(m: PreviewMode) => void>(),
    onPreviewThemeChange: vi.fn<(t: PreviewTheme) => void>(),
  };
}

/** The real call site shape: a saved-state toolbar over a mobile/dark preview. */
function props(
  h: Handlers,
  over: { previewMode?: PreviewMode; previewTheme?: PreviewTheme; saving?: boolean } = {},
) {
  return {
    ...h,
    previewMode: over.previewMode ?? ("mobile" as PreviewMode),
    previewTheme: over.previewTheme ?? ("dark" as PreviewTheme),
    saving: over.saving,
  };
}

function byLabel(container: HTMLElement, label: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no control labelled "${label}"`);
  return el;
}

describe("EditorToolbar", () => {
  it("marks the toggle that matches the current preview mode and theme", async () => {
    const h = handlers();
    const { container, root } = await renderPage(
      EditorToolbar,
      props(h, { previewMode: "mobile", previewTheme: "dark" }),
    );
    try {
      // The container is the toolbar landmark itself.
      const toolbar = container.querySelector('[role="toolbar"]');
      expect(toolbar?.getAttribute("aria-label")).toBe("Editor toolbar");

      // Exactly the two selected options report aria-checked="true". A
      // ToggleGroup wired to the wrong `value` prop flips this.
      const checked = [
        ...container.querySelectorAll<HTMLElement>('[role="radio"]'),
      ]
        .filter((el) => el.getAttribute("aria-checked") === "true")
        .map((el) => el.getAttribute("aria-label"));
      expect(checked.sort()).toEqual(["Dark preview", "Mobile preview"]);

      // ...and every radio carries an accessible name, since each renders
      // nothing but an aria-hidden icon.
      const radios = [
        ...container.querySelectorAll<HTMLElement>('[role="radio"]'),
      ];
      expect(radios).toHaveLength(4);
      for (const r of radios) {
        expect(r.getAttribute("aria-label")).toBeTruthy();
      }
    } finally {
      unmount(root);
    }
  });

  it("names both radiogroups, so the two are told apart", async () => {
    const h = handlers();
    const { container, root } = await renderPage(EditorToolbar, props(h));
    try {
      const groups = [
        ...container.querySelectorAll<HTMLElement>('[role="radiogroup"]'),
      ];
      expect(groups).toHaveLength(2);

      // Fails when either ToggleGroup renders a bare role="radiogroup": a
      // screen reader then announces "radiogroup" twice with nothing to
      // separate the preview-size group from the preview-theme group.
      const names = groups.map(
        (g) =>
          g.getAttribute("aria-label") ??
          (g.getAttribute("aria-labelledby")
            ? (container.querySelector(
                `#${g.getAttribute("aria-labelledby")}`,
              )?.textContent ?? "")
            : ""),
      );
      for (const name of names) expect(name).toBeTruthy();
      expect(new Set(names).size).toBe(2);

      // ...and each name belongs to the group holding the matching radios,
      // so swapping the two labels fails too.
      const byName = new Map(
        groups.map((g, i) => [
          names[i],
          [...g.querySelectorAll('[role="radio"]')].map((r) =>
            r.getAttribute("aria-label"),
          ),
        ]),
      );
      expect(byName.get("Preview size")).toEqual([
        "Desktop preview",
        "Mobile preview",
      ]);
      expect(byName.get("Preview theme")).toEqual([
        "Light preview",
        "Dark preview",
      ]);
    } finally {
      unmount(root);
    }
  });

  it("reports the newly picked mode and theme to its callbacks", async () => {
    const h = handlers();
    const { container, root } = await renderPage(
      EditorToolbar,
      props(h, { previewMode: "mobile", previewTheme: "dark" }),
    );
    try {
      await act(async () => {
        byLabel(container, "Desktop preview").click();
        byLabel(container, "Light preview").click();
      });
      expect(h.onPreviewModeChange).toHaveBeenCalledWith("desktop");
      expect(h.onPreviewThemeChange).toHaveBeenCalledWith("light");
    } finally {
      unmount(root);
    }
  });

  it("calls onUndo and announces it in the live region", async () => {
    const h = handlers();
    const { container, root } = await renderPage(EditorToolbar, props(h));
    try {
      const live = container.querySelector<HTMLElement>('[aria-live="polite"]');
      expect(live).not.toBeNull();
      expect(live?.textContent).toBe("");

      await act(async () => {
        byLabel(container, "Undo last change").click();
      });
      expect(h.onUndo).toHaveBeenCalledTimes(1);
      expect(live?.textContent).toBe("Undid last change");

      await act(async () => {
        byLabel(container, "Redo last change").click();
      });
      expect(h.onRedo).toHaveBeenCalledTimes(1);
      expect(live?.textContent).toBe("Redid last change");
    } finally {
      unmount(root);
    }
  });

  it("disables Save and shows the in-flight label while saving", async () => {
    const h = handlers();
    const { container, root } = await renderPage(
      EditorToolbar,
      props(h, { saving: true }),
    );
    try {
      const save = [...container.querySelectorAll("button")].find((b) =>
        /Saving|Save/.test(b.textContent ?? ""),
      );
      expect(save?.textContent).toContain("Saving…");
      expect((save as HTMLButtonElement).disabled).toBe(true);

      // The click sweep skips disabled controls, so Save must NOT fire.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      expect(h.onSave).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("survives a sweep of every control, and Save fires when idle", async () => {
    const h = handlers();
    const { container, root } = await renderPage(EditorToolbar, props(h));
    try {
      const { clicked, failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      // 2 history + 4 toggles + Save.
      expect(clicked).toBe(7);
      expect(h.onSave).toHaveBeenCalledTimes(1);
    } finally {
      unmount(root);
    }
  });

  it("renders a caller-supplied rightSlot next to Save", async () => {
    const h = handlers();
    const { container, root } = await renderPage(EditorToolbar, {
      ...props(h),
      rightSlot: <span data-testid="slot">Last saved 2m ago</span>,
    });
    try {
      expect(
        container.querySelector('[data-testid="slot"]')?.textContent,
      ).toBe("Last saved 2m ago");
    } finally {
      unmount(root);
    }
  });
});
