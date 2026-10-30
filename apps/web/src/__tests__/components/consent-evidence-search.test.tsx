// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-94: "/" focuses the loaded-evidence search from anywhere on the
// page (but never steals a slash typed into another field), Esc clears a
// non-empty query, and the query narrows loaded rows by email, source, policy,
// or record identity.

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ConsentEvidenceSearch } from "@/components/consent/ConsentEvidenceSearch";
import {
  DEFAULT_CONSENT_VIEW,
  filterConsentReceipts,
} from "@/components/consent/consent-evidence-view";
import type { ConsentReceipt } from "@/lib/consent-receipts-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROWS: ConsentReceipt[] = [
  {
    id: "41",
    subscriber_email: "grace@example.test",
    new_state: "granted",
    source: "form",
    privacy_policy_version: "privacy-2026-07",
    at: "2026-09-01T10:00:00Z",
    recorded_at: "2026-09-01T10:00:00Z",
    kind: "receipt",
  },
  {
    id: "77",
    subscriber_email: "linus@example.test",
    new_state: "granted",
    source: "api",
    privacy_policy_version: "privacy-2025-11",
    at: "2026-08-01T10:00:00Z",
    recorded_at: "2026-08-01T10:00:00Z",
    kind: "proof",
  },
];

function Harness() {
  const [query, setQuery] = useState("");
  const visible = filterConsentReceipts(ROWS, { ...DEFAULT_CONSENT_VIEW, query });
  return createElement(
    "div",
    null,
    createElement("input", { "data-testid": "other-field" }),
    createElement(ConsentEvidenceSearch, { value: query, onChange: setQuery }),
    createElement(
      "ol",
      { "data-testid": "visible" },
      visible.map((row) =>
        createElement("li", { key: row.id }, row.subscriber_email),
      ),
    ),
  );
}

let container: HTMLElement;
let root: Root;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(Harness));
  });
}

function search(): HTMLInputElement {
  return container.querySelector('input[type="search"]') as HTMLInputElement;
}

function visible(): string[] {
  return [
    ...container.querySelectorAll('[data-testid="visible"] li'),
  ].map((li) => li.textContent ?? "");
}

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(search(), value);
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(target: EventTarget, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("ConsentEvidenceSearch", () => {
  it('focuses the search when "/" is pressed outside a text control', async () => {
    await mount();
    expect(document.activeElement).not.toBe(search());

    const event = await press(document.body, "/");

    expect(document.activeElement).toBe(search());
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a "/" typed into another field alone', async () => {
    await mount();
    const other = container.querySelector(
      '[data-testid="other-field"]',
    ) as HTMLInputElement;
    other.focus();

    const event = await press(other, "/");

    expect(document.activeElement).toBe(other);
    expect(event.defaultPrevented).toBe(false);
  });

  it("searches loaded rows by email, policy, and record identity; Esc clears", async () => {
    await mount();
    await type("grace");
    expect(visible()).toEqual(["grace@example.test"]);

    await type("2025-11");
    expect(visible()).toEqual(["linus@example.test"]);

    await type("proof:77");
    expect(visible()).toEqual(["linus@example.test"]);

    const escape = await press(search(), "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(search().value).toBe("");
    expect(visible()).toEqual(["grace@example.test", "linus@example.test"]);
  });

  it("does not swallow Esc when there is nothing to clear", async () => {
    await mount();
    const escape = await press(search(), "Escape");
    expect(escape.defaultPrevented).toBe(false);
  });
});
