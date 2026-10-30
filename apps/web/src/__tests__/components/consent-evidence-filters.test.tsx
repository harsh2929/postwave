// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-93: source chips, recorded outcome, evidence type, occurrence
// period, loaded order, and Reset view. The harness renders the rows the
// filters leave visible, so each assertion is on what an operator would see —
// literal expected emails, never a value derived from the code under test.

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ConsentEvidenceFilters } from "@/components/consent/ConsentEvidenceFilters";
import {
  consentSourceCounts,
  DEFAULT_CONSENT_VIEW,
  filterConsentReceipts,
  type ConsentEvidenceView,
} from "@/components/consent/consent-evidence-view";
import type { ConsentReceipt } from "@/lib/consent-receipts-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-10T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const ROWS: ConsentReceipt[] = [
  {
    id: "1",
    subscriber_email: "form.optin@example.test",
    new_state: "granted",
    source: "form_embed",
    at: ago(2),
    recorded_at: ago(2),
    kind: "receipt",
  },
  {
    id: "2",
    subscriber_email: "api.optout@example.test",
    new_state: "withdrawn",
    source: "api",
    at: ago(20),
    recorded_at: ago(20),
    kind: "receipt",
  },
  {
    id: "3",
    subscriber_email: "import.proof@example.test",
    new_state: "subscribed",
    source: "csv_import",
    at: ago(60),
    recorded_at: ago(60),
    kind: "proof",
  },
  {
    id: "4",
    subscriber_email: "migration.pending@example.test",
    new_state: "pending",
    source: "migration_mailchimp",
    at: ago(200),
    recorded_at: ago(200),
    kind: "proof",
  },
];

function Harness() {
  const [view, setView] = useState<ConsentEvidenceView>(DEFAULT_CONSENT_VIEW);
  const visible = filterConsentReceipts(ROWS, view, NOW);
  return createElement(
    "div",
    null,
    createElement(ConsentEvidenceFilters, {
      view,
      sourceCounts: consentSourceCounts(ROWS),
      onChange: (patch) => setView((current) => ({ ...current, ...patch })),
      onReset: () => setView(DEFAULT_CONSENT_VIEW),
    }),
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

function visible(): string[] {
  return [
    ...container.querySelectorAll('[data-testid="visible"] li'),
  ].map((li) => li.textContent ?? "");
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}

async function choose(label: string, value: string) {
  const select = [...container.querySelectorAll("label")]
    .find((l) => l.textContent === label)
    ?.getAttribute("for");
  const element = container.querySelector<HTMLSelectElement>(
    `select[id="${select}"]`,
  );
  if (!element) throw new Error(`Missing select: ${label}`);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("ConsentEvidenceFilters", () => {
  it("labels each source chip with its loaded count and filters by bucket", async () => {
    await mount();
    expect(
      container.querySelector('button[aria-label="Imports, 1 loaded"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="All sources, 4 loaded"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    await click(
      container.querySelector(
        'button[aria-label="Migration / public, 1 loaded"]',
      ) as HTMLButtonElement,
    );
    expect(visible()).toEqual(["migration.pending@example.test"]);
    expect(
      container.querySelector(
        'button[aria-label="Migration / public, 1 loaded"]',
      )?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.textContent).toContain("1 filter applied");
  });

  it("filters by recorded outcome, evidence type, and a bounded period", async () => {
    await mount();
    await choose("Recorded outcome", "opt-out");
    expect(visible()).toEqual(["api.optout@example.test"]);

    await choose("Recorded outcome", "all");
    await choose("Evidence type", "proof");
    expect(visible()).toEqual([
      "import.proof@example.test",
      "migration.pending@example.test",
    ]);

    await choose("Evidence type", "all");
    await choose("Occurred", "30d");
    expect(visible()).toEqual([
      "form.optin@example.test",
      "api.optout@example.test",
    ]);
  });

  it("reverses the loaded order and Reset view restores the default view", async () => {
    await mount();
    expect(visible()[0]).toBe("form.optin@example.test");
    expect(() => button("Reset view")).toThrow();

    await choose("Loaded order", "asc");
    expect(visible()).toEqual([
      "migration.pending@example.test",
      "import.proof@example.test",
      "api.optout@example.test",
      "form.optin@example.test",
    ]);
    await choose("Evidence type", "receipt");
    expect(container.textContent).toContain("2 filters applied");

    await click(button("Reset view"));
    expect(visible()).toEqual([
      "form.optin@example.test",
      "api.optout@example.test",
      "import.proof@example.test",
      "migration.pending@example.test",
    ]);
    expect(container.textContent).toContain(
      "No filters applied · newest recorded evidence first",
    );
  });
});
