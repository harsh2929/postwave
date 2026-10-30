// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SelectedAudienceScopeCard } from "@/app/(dashboard)/app/migrations/[jobId]/selected-audience-scope-card";
import type { MigrationJob } from "@/lib/types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

function job(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: "job_1",
    tenant_id: "tenant_1",
    source: "mailchimp",
    status: "completed",
    progress: {
      subscribers_total: 10,
      subscribers_done: 10,
      segments_total: 0,
      segments_done: 0,
      automations_total: 0,
      automations_done: 0,
      paid_subs_total: 0,
      paid_subs_done: 0,
      archive_total: 0,
      archive_done: 0,
    },
    cursor: {},
    started_at: "2026-07-02T00:00:00.000Z",
    completed_at: "2026-07-02T00:30:00.000Z",
    rollback_until: "2026-07-09T00:30:00.000Z",
    verification_report: null,
    error: null,
    ...overrides,
  };
}

describe("SelectedAudienceScopeCard", () => {
  it("renders selected Mailchimp audience ids on the migration detail page", () => {
    const root = render(
      createElement(SelectedAudienceScopeCard, {
        job: job({ selected_audience_ids: ["aud_a", "aud_b"] }),
      }),
    );

    try {
      expect(document.body.textContent).toContain("Mailchimp audience scope");
      expect(document.body.textContent).toContain(
        "used 2 selected audiences for audience-bound records",
      );
      expect(document.body.textContent).toContain("aud_a");
      expect(document.body.textContent).toContain("aud_b");
      expect(document.body.textContent).toContain(
        "signup-form and audience-schema evidence, list-triggered Classic Automations, campaigns, and reports",
      );
      expect(document.body.textContent).toContain(
        "Account-global: templates, landing pages, ecommerce evidence",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("fails visibly for unscoped Mailchimp jobs and stays hidden for other sources", () => {
    const root = render(
      createElement(
        "div",
        null,
        createElement(SelectedAudienceScopeCard, { job: job() }),
        createElement(SelectedAudienceScopeCard, {
          job: job({
            source: "beehiiv",
            selected_audience_ids: ["aud_a"],
          }),
        }),
      ),
    );

    try {
      expect(document.body.textContent).toContain(
        "Mailchimp audience scope missing",
      );
      expect(document.body.textContent).toContain(
        "No explicit audience IDs are recorded",
      );
      expect(document.body.textContent).not.toContain("aud_a");
    } finally {
      act(() => root.unmount());
    }
  });
});
