// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-106: the register stat strip counts only loaded rows, carries a
// hint under each number that disclaims legal determination, and "Learn the
// workflow" opens the four-stage explainer that "Got it" dismisses.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { PrivacyIncidentStatStrip } from "@/components/privacy/PrivacyIncidentStatStrip";
import type { PrivacyIncident } from "@/lib/privacy-incidents-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-09-10T12:00:00Z");

function incident(over: Partial<PrivacyIncident>): PrivacyIncident {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    severity: "low",
    status: "open",
    detected_at: "2026-09-09T12:00:00Z",
    template_version: "v1",
    affected_regions: ["EU"],
    affected_data_categories: ["email"],
    affected_subject_count: 10,
    notification_decisions: {},
    jurisdictions: ["GB"],
    summary: "Incident",
    created_at: "2026-09-09T12:00:00Z",
    updated_at: "2026-09-09T12:00:00Z",
    ...over,
  };
}

const ROWS: PrivacyIncident[] = [
  // Target passed, low severity, scope complete → attention + passed.
  incident({ id: "a", gdpr_72h_deadline: "2026-09-10T11:00:00Z" }),
  // Critical, target in the future, missing subject estimate.
  incident({
    id: "b",
    severity: "critical",
    gdpr_72h_deadline: "2026-09-12T11:00:00Z",
    affected_subject_count: undefined,
  }),
  // Closed high-severity row with a passed target: terminal, never "attention".
  incident({
    id: "c",
    status: "closed",
    severity: "high",
    gdpr_72h_deadline: "2026-09-01T00:00:00Z",
  }),
  // Contained, medium, no jurisdictions.
  incident({ id: "d", status: "contained", severity: "medium", jurisdictions: [] }),
];

let container: HTMLElement;
let root: Root;

async function mount(rows: PrivacyIncident[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(PrivacyIncidentStatStrip, { rows, now: NOW }));
  });
}

function cells(): string[][] {
  return [...container.querySelectorAll("dl > div")].map((cell) =>
    [...cell.children].map((child) => child.textContent ?? ""),
  );
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("PrivacyIncidentStatStrip", () => {
  it("counts loaded rows only and scopes each number with its hint", async () => {
    await mount(ROWS);
    expect(cells()).toEqual([
      [
        "Needs attention",
        "2",
        "Loaded non-terminal rows whose stored operational target has passed or whose recorded severity is high or critical. This is a triage signal, not a legal determination.",
      ],
      [
        "Operational target passed",
        "1",
        "Loaded non-terminal rows whose stored system target is earlier than now. The target is not represented as a legal deadline.",
      ],
      [
        "Loaded non-terminal",
        "3",
        "Loaded rows in open, contained, or notifying state. State is an operator record, not independent containment or delivery proof.",
      ],
      [
        "Scope fields complete",
        "2 / 4",
        "Loaded rows with stored regions, data categories, subject estimate, and jurisdictions. Four present fields do not establish correct or complete legal scope.",
      ],
    ]);
    expect(container.textContent).toContain(
      "Every count covers only the 4 rows loaded in this browser.",
    );
  });

  it("opens the workflow explainer and closes it with Got it", async () => {
    await mount(ROWS);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      button("Learn the workflow").click();
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("The breach-response workflow");
    expect(
      [...(dialog?.querySelectorAll("li p:first-child") ?? [])].map(
        (p) => p.textContent,
      ),
    ).toEqual([
      "Open",
      "Contained",
      "Notifications pending",
      "Closed (release-held)",
    ]);
    expect(dialog?.textContent).toContain(
      "Closure is unavailable until independent counsel identity",
    );

    await act(async () => {
      button("Got it").click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
