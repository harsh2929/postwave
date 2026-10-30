// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Regression: the embed-snippet code block hand-rolled its clipboard write as
// `void navigator.clipboard.writeText(value)` — not awaited, not caught — and
// then set `copied` unconditionally. A rejected write (non-secure context,
// permission denied, document not focused) produced a confident "Copied" while
// nothing reached the clipboard.
//
// That is precisely what `lib/clipboard.ts` exists to prevent; its contract
// says a rejected write "must be surfaced ... not swallowed", and
// CopyTextButton implements exactly that. This one call site bypassed both.
//
// It matters most here of all places: the whole purpose of the page is to hand
// the operator a snippet to paste into their site. A silent no-op ends with an
// embed that was never installed and no indication why.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmbedSnippet } from "@/components/forms/embed-snippet";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    warning: vi.fn(),
  },
}));

// React only flushes updates inside act() when this flag is set.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  setClipboard(undefined);
});

/**
 * Replace ONLY navigator.clipboard. Stubbing the whole navigator object breaks
 * React's own rendering (it reads userAgent), which silently produced an empty
 * tree and a test that failed for the wrong reason.
 */
function setClipboard(clipboard: unknown) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: clipboard,
    configurable: true,
    writable: true,
  });
}

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <EmbedSnippet slug="signup" host="https://forms.example.test" />,
    );
  });
}

function copyButton(): HTMLButtonElement {
  const buttons = [...host!.querySelectorAll("button")];
  const btn = buttons.find((b) => /copy/i.test(b.textContent ?? ""));
  if (!btn) throw new Error("no copy button rendered");
  return btn as HTMLButtonElement;
}

describe("embed snippet copy button", () => {
  it("contains its controls while leaving long code keyboard-scrollable", async () => {
    await mount();

    expect(host?.firstElementChild?.classList.contains("min-w-0")).toBe(true);
    expect(
      host?.querySelector('[role="tabpanel"]')?.classList.contains("min-w-0"),
    ).toBe(true);

    const snippet = host?.querySelector<HTMLElement>(
      '[role="group"][aria-label="Embed snippet"]',
    );
    expect(snippet?.tabIndex).toBe(0);
    expect(snippet?.classList.contains("max-w-full")).toBe(true);
    expect(snippet?.classList.contains("overflow-x-auto")).toBe(true);
    expect(snippet?.parentElement?.classList.contains("min-w-0")).toBe(true);
  });

  it("reports success when the clipboard write resolves", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await mount();
    const btn = copyButton();
    await act(async () => {
      btn.click();
    });

    expect(writeText).toHaveBeenCalled();
    expect(btn.textContent).toMatch(/copied/i);
  });

  it("does NOT claim success when the clipboard write is rejected", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText });

    await mount();
    const btn = copyButton();
    await act(async () => {
      btn.click();
    });

    expect(writeText).toHaveBeenCalled();
    expect(btn.textContent).not.toMatch(/copied/i);
  });

  it("does NOT claim success when there is no Clipboard API at all", async () => {
    setClipboard(undefined);

    await mount();
    const btn = copyButton();
    await act(async () => {
      btn.click();
    });

    expect(btn.textContent).not.toMatch(/copied/i);
  });
});
