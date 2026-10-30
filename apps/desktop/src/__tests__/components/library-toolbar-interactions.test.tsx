// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LibraryToolbar } from "../../components/library/LibraryToolbar";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderToolbar(
  canUpload: boolean,
  onUpload = vi.fn(),
  onSearchChange = vi.fn(),
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <LibraryToolbar
        query=""
        sort="newest"
        viewMode="grid"
        density="cozy"
        canUpload={canUpload}
        onSearchChange={onSearchChange}
        onSortChange={vi.fn()}
        onViewModeChange={vi.fn()}
        onDensityChange={vi.fn()}
        onUpload={onUpload}
      />,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

describe("LibraryToolbar interactions", () => {
  it("keeps viewer upload focusable, guarded, and visibly explained", async () => {
    const onUpload = vi.fn();
    renderToolbar(false, onUpload);

    const upload = button("Upload");
    expect(upload.disabled).toBe(false);
    expect(upload.getAttribute("aria-disabled")).toBe("true");
    upload.focus();
    expect(document.activeElement).toBe(upload);
    act(() => upload.click());
    expect(onUpload).not.toHaveBeenCalled();

    const reasonId = upload.getAttribute("aria-describedby");
    expect(document.getElementById(reasonId ?? "")?.textContent).toBe(
      "Viewer access can browse assets but cannot upload them.",
    );
    expect(document.querySelector("[title]")).toBeNull();
    expect(button("Grid").getAttribute("aria-pressed")).toBe("true");
    expect(button("List").getAttribute("aria-pressed")).toBe("false");

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("executes upload once when the workspace permits it", () => {
    const onUpload = vi.fn();
    renderToolbar(true, onUpload);
    const upload = button("Upload");
    expect(upload.getAttribute("aria-disabled")).toBeNull();
    expect(upload.getAttribute("aria-describedby")).toBeNull();
    act(() => upload.click());
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it("waits for IME composition to finish before requesting a search", async () => {
    const onSearchChange = vi.fn();
    renderToolbar(true, vi.fn(), onSearchChange);
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search assets"]',
    );
    if (!search) throw new Error("Missing asset search input");
    const setInputValue = (value: string): void => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, value);
    };

    act(() => {
      search.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      setInputValue("春");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onSearchChange).not.toHaveBeenCalled();

    act(() => {
      search.dispatchEvent(new Event("compositionend", { bubbles: true }));
    });
    expect(onSearchChange).toHaveBeenCalledTimes(1);
    expect(onSearchChange).toHaveBeenLastCalledWith("春");

    await act(async () => Promise.resolve());
    act(() => {
      setInputValue("春季");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onSearchChange).toHaveBeenCalledTimes(2);
    expect(onSearchChange).toHaveBeenLastCalledWith("春季");
  });
});
