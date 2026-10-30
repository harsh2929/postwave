// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Regression: CopyLink's catch block promised "Clipboard blocked — let the
// default anchor navigation proceed", but `e.preventDefault()` ran BEFORE the
// await that could throw. The default was already cancelled by the time the
// clipboard rejected, and preventDefault cannot be undone, so the branch did
// nothing at all.
//
// Net effect in any context without clipboard access (plain http://, denied
// permission, unfocused document): clicking the permalink icon copied nothing,
// navigated nowhere, and showed no feedback — a completely dead control, on the
// affordance whose entire job is handing someone a link.
//
// preventDefault still has to be called synchronously to be effective, so the
// fix performs the navigation itself on failure rather than trying to un-cancel.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyLink } from "@/components/marketing/copy-link";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function setClipboard(clipboard: unknown) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: clipboard,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  setClipboard(undefined);
  window.location.hash = "";
});

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<CopyLink hash="v0-4-0" label="Copy link to v0.4.0" />);
  });
  return host.querySelector("a") as HTMLAnchorElement;
}

async function click(anchor: HTMLAnchorElement) {
  await act(async () => {
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  // Let the awaited clipboard promise settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("CopyLink", () => {
  it("copies the absolute URL and reflects the hash", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    const anchor = await mount();
    await click(anchor);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]![0])).toContain("#v0-4-0");
    expect(window.location.hash).toBe("#v0-4-0");
  });

  it("still navigates to the target when the clipboard is blocked", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText });

    const anchor = await mount();
    await click(anchor);

    expect(writeText).toHaveBeenCalledTimes(1);
    // The control must do SOMETHING — falling back to the plain in-page link.
    expect(window.location.hash).toBe("#v0-4-0");
  });

  it("still navigates when there is no Clipboard API at all", async () => {
    setClipboard(undefined);

    const anchor = await mount();
    await click(anchor);

    expect(window.location.hash).toBe("#v0-4-0");
  });
});
