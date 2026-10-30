// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-86 / 87: the show-once SCIM token reveal (masking, secret copy
// with a 60 s clear-if-unchanged, acknowledgement gate, and the
// close-without-storing confirm) and the token-prefix row copy.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScimTokenPrefixCopy } from "@/components/settings/scim-token-prefix-copy";
import {
  maskToken,
  ScimTokenReveal,
} from "@/components/settings/scim-token-reveal";
import {
  cancelPendingSecretClipboardClears,
  copySecretWithAutoClear,
  SECRET_CLIPBOARD_CLEAR_MS,
} from "@/lib/secret-clipboard";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const TOKEN = "pst_live_abcdefghijklmnopqrstuvwxyz0123456789SECRET";
const MINTED = { token: TOKEN, prefix: "pst_live", warning: "Shown once." };

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  cancelPendingSecretClipboardClears();
  vi.useRealTimers();
  vi.clearAllMocks();
  Reflect.deleteProperty(window.navigator, "clipboard");
  document.body.innerHTML = "";
});

function render(ui: ReactNode): void {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(ui));
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (element) => element.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return match;
}

function stubClipboard(initial = "") {
  let contents = initial;
  const writeText = vi.fn(async (text: string) => {
    contents = text;
  });
  const readText = vi.fn(async () => contents);
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText, readText },
    configurable: true,
  });
  return {
    writeText,
    readText,
    current: () => contents,
    userCopies: (text: string) => {
      contents = text;
    },
  };
}

function tokenText(): string {
  return (
    document.querySelector('[data-testid="scim-token-value"]')?.textContent ??
    ""
  );
}

describe("ScimTokenReveal (governance-86)", () => {
  it("masks and unmasks the one-time token without dropping it", () => {
    render(createElement(ScimTokenReveal, { minted: MINTED, onDismiss: vi.fn() }));

    expect(tokenText()).toBe(TOKEN);
    act(() => buttonByText("Hide").click());
    expect(tokenText()).toBe(maskToken(TOKEN));
    expect(tokenText()).toMatch(/^•{48}$/u);
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(buttonByText("Show").getAttribute("aria-pressed")).toBe("true");

    act(() => buttonByText("Show").click());
    expect(tokenText()).toBe(TOKEN);
  });

  it("copies the full secret and clears the clipboard after 60 s only if unchanged", async () => {
    const clipboard = stubClipboard("previous clipboard");
    render(createElement(ScimTokenReveal, { minted: MINTED, onDismiss: vi.fn() }));
    act(() => buttonByText("Hide").click());
    vi.useFakeTimers();

    await act(async () => buttonByText("Copy token").click());
    await settle();

    expect(clipboard.writeText.mock.calls).toEqual([[TOKEN]]);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Token copied. Moosewave will clear the clipboard in 60 seconds if it still holds this token.",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(clipboard.current()).toBe(TOKEN);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle();
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText.mock.calls).toEqual([[TOKEN], [""]]);
    expect(clipboard.current()).toBe("");
  });

  it("leaves a later user copy alone when the timer fires", async () => {
    const clipboard = stubClipboard();
    const outcomes: string[] = [];
    vi.useFakeTimers();
    await copySecretWithAutoClear(TOKEN, {
      onClearOutcome: (outcome) => outcomes.push(outcome),
    });
    clipboard.userCopies("something the user copied later");
    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS);
    expect(SECRET_CLIPBOARD_CLEAR_MS).toBe(60_000);
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText.mock.calls).toEqual([[TOKEN]]);
    expect(clipboard.current()).toBe("something the user copied later");
    expect(outcomes).toEqual(["changed"]);
  });

  it("tells the user when the clipboard could not be cleared", async () => {
    const clipboard = stubClipboard();
    clipboard.readText.mockRejectedValue(new Error("denied"));
    render(createElement(ScimTokenReveal, { minted: MINTED, onDismiss: vi.fn() }));
    vi.useFakeTimers();

    await act(async () => buttonByText("Copy token").click());
    await settle();
    expect(mocks.toastError).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS);
    });
    await settle();

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Moosewave could not clear the SCIM token from the clipboard. Clear it manually.",
    );
    expect(clipboard.current()).toBe(TOKEN);
  });

  it("gates Done on the stored acknowledgement", () => {
    const onDismiss = vi.fn();
    render(createElement(ScimTokenReveal, { minted: MINTED, onDismiss }));

    const done = buttonByText("Done — I've saved it");
    expect(done.disabled).toBe(true);
    act(() => done.click());
    expect(onDismiss).not.toHaveBeenCalled();

    const checkbox = document.querySelector('input[type="checkbox"]');
    if (!(checkbox instanceof HTMLInputElement)) throw new Error("no checkbox");
    act(() => checkbox.click());
    expect(buttonByText("Done — I've saved it").disabled).toBe(false);
    act(() => buttonByText("Done — I've saved it").click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("confirms, naming the consequence, before discarding an unstored token", async () => {
    const onDismiss = vi.fn();
    render(createElement(ScimTokenReveal, { minted: MINTED, onDismiss }));

    act(() => buttonByText("Close").click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Close without storing this token?");
    expect(dialog?.textContent).toContain(
      "The full SCIM token is shown once and cannot be recovered. You will need to revoke it and mint another.",
    );
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => buttonByText("Keep token open").click());
    await settle();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(tokenText()).toBe(TOKEN);

    act(() => buttonByText("Close").click());
    await settle();
    await act(async () => buttonByText("Discard shown token").click());
    await settle();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("closes without a confirm once storage was acknowledged", async () => {
    const onDismiss = vi.fn();
    render(createElement(ScimTokenReveal, { minted: MINTED, onDismiss }));
    const checkbox = document.querySelector('input[type="checkbox"]');
    if (!(checkbox instanceof HTMLInputElement)) throw new Error("no checkbox");
    act(() => checkbox.click());
    act(() => buttonByText("Close").click());
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("ScimTokenPrefixCopy (governance-87)", () => {
  it("copies exactly the public prefix and schedules no clipboard clear", async () => {
    const clipboard = stubClipboard();
    render(createElement(ScimTokenPrefixCopy, { prefix: "pst_live" }));
    const button = document.querySelector(
      'button[aria-label="Copy token prefix pst_live for IdP log searches"]',
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("no button");
    vi.useFakeTimers();

    await act(async () => button.click());
    await settle();

    expect(clipboard.writeText.mock.calls).toEqual([["pst_live"]]);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Copied token prefix pst_live.",
    );
    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS);
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.current()).toBe("pst_live");
  });

  it("is withheld while the caller disables it", () => {
    stubClipboard();
    render(
      createElement(ScimTokenPrefixCopy, { prefix: "pst_live", disabled: true }),
    );
    expect(buttonByText("Copy prefix").disabled).toBe(true);
  });
});
