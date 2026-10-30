// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ReceiptDrawer } from "../../pages/Consent";
import type { ConsentReceipt } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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
  document.body.style.overflow = "";
});

const receipt: ConsentReceipt = {
  id: "12345678",
  kind: "receipt",
  subscriber_email: "ada@example.test",
  source: "form:newsletter",
  source_detail: "Footer form",
  prev_state: "unconfirmed",
  new_state: "subscribed",
  ip: "192.0.2.10",
  user_agent: "Test Browser",
  privacy_policy_version: "2026-07",
  captured_text: "I agree",
  at: "2026-07-17T08:00:00.000Z",
  recorded_at: "2026-07-17T08:00:01.000000Z",
};

function Harness(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open receipt
      </button>
      {open ? (
        <ReceiptDrawer receipt={receipt} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

function key(keyValue: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: keyValue,
      ...init,
    }),
  );
}

describe("ReceiptDrawer", () => {
  it("is named, described, pointer-dismissible, IME-safe, and restores focus", async () => {
    render();
    const trigger = document.querySelector<HTMLButtonElement>("button")!;
    trigger.focus();
    act(() => trigger.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const title = document.getElementById(
      dialog.getAttribute("aria-labelledby")!,
    );
    const description = document.getElementById(
      dialog.getAttribute("aria-describedby")!,
    );
    expect(title?.textContent).toBe("ada@example.test");
    expect(description?.textContent).toContain(
      "Recorded evidence receipt:12345678",
    );
    expect(document.activeElement?.textContent).toContain(
      "Review raw evidence",
    );
    expect(dialog.textContent).not.toContain("Copy");
    expect(document.body.style.overflow).toBe("hidden");

    act(() => key("Escape", { isComposing: true }));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    const result = await axe.run(dialog);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    act(() => {
      document
        .querySelector<HTMLElement>(".slideover-overlay")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await act(async () => Promise.resolve());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
  });
});
