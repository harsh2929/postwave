// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-95: the Review drawer renders the exact loaded row, and the raw
// payload — which can carry an email, IP address, and user agent — stays
// collapsed behind a disclosure whose warning precedes the JSON.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsentReceiptDrawer } from "@/components/consent/ConsentReceiptDrawer";
import type { ConsentReceipt } from "@/lib/consent-receipts-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROOF: ConsentReceipt = {
  id: "0b6f9c1e-8a0d-4c55-9a47-4f1f8f7d2a10",
  subscriber_email: "sensitive.person@example.test",
  prev_state: "pending",
  new_state: "granted",
  source: "form",
  source_detail: "footer-newsletter",
  ip: "198.51.100.23",
  user_agent: "Mozilla/5.0 (Macintosh)",
  at: "2026-08-01T10:00:00Z",
  recorded_at: "2026-08-21T10:00:03.062504Z",
  kind: "proof",
};

let container: HTMLElement;
let root: Root;
const onClose = vi.fn();

async function mount(receipt: ConsentReceipt | null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(ConsentReceiptDrawer, { receipt, onClose }));
  });
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error("drawer is not open");
  return found;
}

function fact(term: string): string | undefined {
  const dt = [...dialog().querySelectorAll("dt")].find(
    (node) => node.textContent === term,
  );
  return dt?.nextElementSibling?.textContent ?? undefined;
}

afterEach(() => {
  act(() => root.unmount());
  onClose.mockReset();
  document.body.innerHTML = "";
});

describe("ConsentReceiptDrawer", () => {
  it("renders nothing without a selected receipt", async () => {
    await mount(null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows the exact recorded identity, state change, and provenance of the loaded row", async () => {
    await mount(PROOF);
    expect(dialog().textContent).toContain("sensitive.person@example.test");
    expect(dialog().textContent).toContain("Structured proof");
    expect(fact("Exact identity")).toBe(
      "proof:0b6f9c1e-8a0d-4c55-9a47-4f1f8f7d2a10",
    );
    expect(fact("Prior state")).toBe("pending");
    expect(fact("Source detail")).toBe("footer-newsletter");
    expect(fact("Policy version")).toBe("Not recorded");
    expect(fact("Captured text")).toBe("Not recorded");
    expect(dialog().textContent).toContain(
      "3 of 5 optional context fields recorded",
    );
    expect(dialog().textContent).toContain("2026-08-21T10:00:03.062Z");
  });

  it("keeps the raw payload collapsed behind the PII warning until the operator opens it", async () => {
    await mount(PROOF);
    const details = dialog().querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);

    const [summary, warning, pre] = [...details.children];
    expect(summary?.tagName).toBe("SUMMARY");
    expect(warning?.textContent).toContain("Sensitive personal data");
    expect(warning?.textContent).toContain(
      "The raw payload can contain an email address, IP address, browser details, policy text, and source metadata.",
    );
    expect(pre?.tagName).toBe("PRE");
    expect(JSON.parse(pre?.textContent ?? "")).toEqual(PROOF);

    const reveal = [...dialog().querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Review raw evidence",
    ) as HTMLButtonElement;
    await act(async () => {
      reveal.click();
    });
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(summary);
  });

  it("closes through the dialog close control", async () => {
    await mount(PROOF);
    const close = [...dialog().querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Close",
    ) as HTMLButtonElement;
    await act(async () => {
      close.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
