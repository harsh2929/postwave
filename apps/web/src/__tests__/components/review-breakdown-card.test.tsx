// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewBreakdownCard } from "@/app/(dashboard)/app/migrations/new/[source]/review-breakdown-card";
import type { VerificationReport } from "@/lib/types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.clearAllMocks();
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

function report(
  overrides: Partial<VerificationReport> = {},
): VerificationReport {
  return {
    subscribers_imported: 1234,
    suppression_list_size: 42,
    custom_fields_mapped: [
      {
        source: "FNAME",
        canonical: "first_name",
        type: "string",
      },
    ],
    custom_fields_unmapped: ["legacy_score"],
    segments_translated: 27,
    segments_with_warnings: [
      {
        name: "VIP buyers",
        warning: "Uses a source-only purchase predicate.",
      },
    ],
    automations_translated: 4,
    automations_unsupported: [
      {
        name: "Birthday journey",
        reason: "Date-based branch needs a manual rebuild.",
      },
    ],
    paid_subs_imported: 18,
    archive_imported: 88,
    resource_completeness: [
      {
        resource: "subscribers",
        label: "Subscribers",
        source_total: 1234,
        imported: 1234,
        supported: true,
        status: "imported_runtime",
      },
    ],
    data_loss_estimate_pct: 2,
    ...overrides,
  };
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("ReviewBreakdownCard", () => {
  it("renders dry-run stats, warnings, and callback controls", () => {
    const onBack = vi.fn();
    const onCommit = vi.fn();
    const root = render(
      createElement(ReviewBreakdownCard, {
        busy: false,
        report: report(),
        onBack,
        onCommit,
      }),
    );

    try {
      expect(document.body.textContent).toContain("Full dry-run breakdown");
      expect(document.body.textContent).toContain("98.0% fidelity");
      expect(document.body.textContent).toContain("1,234");
      expect(document.body.textContent).toContain("27");
      expect(document.body.textContent).toContain("FNAME");
      expect(document.body.textContent).toContain("first_name");
      expect(document.body.textContent).toContain("legacy_score");
      expect(document.body.textContent).toContain(
        "Preserved as subscriber attributes",
      );
      expect(document.body.textContent).toContain("Birthday journey");
      expect(document.body.textContent).toContain(
        "Date-based branch needs a manual rebuild.",
      );
      expect(document.body.textContent).toContain("VIP buyers");
      expect(document.body.textContent).toContain(
        "Uses a source-only purchase predicate.",
      );

      const recreateLink = document.querySelector<HTMLAnchorElement>(
        'a[href="/app/sequences/new"]',
      );
      expect(recreateLink?.textContent).toContain("Recreate in Sequences");

      act(() => {
        buttonByText("Go back / re-map").click();
      });
      expect(onBack).toHaveBeenCalledTimes(1);

      act(() => {
        buttonByText("Commit migration").click();
      });
      expect(onCommit).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("shows fidelity warning styling and disables commit while busy", () => {
    const root = render(
      createElement(ReviewBreakdownCard, {
        busy: true,
        report: report({ data_loss_estimate_pct: 4.5 }),
        onBack: vi.fn(),
        onCommit: vi.fn(),
      }),
    );

    try {
      const badge = Array.from(document.querySelectorAll("div")).find(
        (element) => element.textContent?.trim() === "95.5% fidelity",
      );
      expect(badge?.className).toContain("bg-warning-subtle");
      expect(buttonByText("Commit migration").disabled).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("labels ActiveCampaign automation work as rebuild review", () => {
    const root = render(
      createElement(ReviewBreakdownCard, {
        busy: false,
        source: "activecampaign",
        report: report({
          automations_translated: 0,
          automations_unsupported: [
            {
              name: "ActiveCampaign automation 1",
              reason: "Preserved for rebuild review.",
            },
            {
              name: "ActiveCampaign automation 2",
              reason: "Preserved for rebuild review.",
            },
          ],
          resource_completeness: [
            {
              resource: "automations",
              label: "Automations",
              source_total: 2,
              imported: 0,
              supported: true,
              status: "manual_rebuild_required",
            },
          ],
        }),
        onBack: vi.fn(),
        onCommit: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain("Automation rebuilds");
      expect(document.body.textContent).toContain(
        "Automation rebuilds to review",
      );
      expect(document.body.textContent).toContain("Rebuild in Sequences");
      expect(document.body.textContent).not.toContain("Recreate in Sequences");
      expect(document.body.textContent).not.toContain(
        "Automations we can't translate",
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("labels Beehiiv rebuild evidence and metadata without claiming Stripe billing", () => {
    const root = render(
      createElement(ReviewBreakdownCard, {
        busy: false,
        source: "beehiiv",
        report: report({
          automations_translated: 0,
          paid_subs_imported: 0,
          resource_completeness: [
            {
              resource: "automations",
              label: "Automation rebuild records",
              source_total: 2,
              imported: 2,
              supported: true,
              status: "preserved_for_rebuild",
            },
            {
              resource: "premium_memberships",
              label: "Premium membership metadata",
              source_total: 18,
              imported: 18,
              supported: true,
              status: "imported_runtime",
            },
          ],
        }),
        onBack: vi.fn(),
        onCommit: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "Frozen segment/list snapshots",
      );
      expect(document.body.textContent).toContain("Automation rebuild records");
      expect(document.body.textContent).toContain(
        "Beehiiv automations to rebuild or retire",
      );
      expect(document.body.textContent).toContain(
        "Premium memberships (metadata)",
      );
      expect(document.body.textContent).toContain(
        "Stripe billing objects imported",
      );
      expect(document.body.textContent).not.toContain("Paid subs");
      expect(document.body.textContent).toContain("Rebuild in Sequences");
    } finally {
      act(() => root.unmount());
    }
  });

  it("labels HubSpot segment totals as combined list and subscription targeting boundaries", () => {
    const root = render(
      createElement(ReviewBreakdownCard, {
        busy: false,
        source: "hubspot",
        report: report({
          segments_translated: 3,
          automations_translated: 0,
          paid_subs_imported: 0,
        }),
        onBack: vi.fn(),
        onCommit: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "Frozen list/subscription targeting boundaries",
      );
      expect(document.body.textContent).not.toContain(
        "Frozen list snapshots",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("labels Klaviyo profiles, snapshots, archive, and flows as bounded rebuild work", () => {
    const root = render(
      createElement(ReviewBreakdownCard, {
        busy: false,
        source: "klaviyo",
        report: report({
          automations_translated: 0,
          paid_subs_imported: 0,
          automations_unsupported: [
            {
              name: "Welcome flow",
              reason: "Executable flow graph requires rebuild review.",
            },
          ],
          resource_completeness: [
            {
              resource: "automations",
              label: "Klaviyo flows",
              source_total: 1,
              imported: 1,
              supported: true,
              status: "preserved_for_rebuild",
            },
          ],
        }),
        onBack: vi.fn(),
        onCommit: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain("Primary-email profiles");
      expect(document.body.textContent).toContain(
        "Suppression-filtered audience snapshots",
      );
      expect(document.body.textContent).toContain("Flow rebuild records");
      expect(document.body.textContent).toContain(
        "Sent email campaign archive",
      );
      expect(document.body.textContent).toContain(
        "SMS/push and rebuild source archive",
      );
      expect(document.body.textContent).not.toContain("Sent channel archive");
      expect(document.body.textContent).toContain(
        "Klaviyo flows to rebuild or waive",
      );
      expect(document.body.textContent).toContain("Rebuild in Sequences");
      expect(document.body.textContent).not.toContain("Automations");
    } finally {
      act(() => root.unmount());
    }
  });

  it("labels Customer.io profiles, memberships, newsletters, and workflow evidence without billing claims", () => {
    const root = render(
      createElement(ReviewBreakdownCard, {
        busy: false,
        source: "customerio",
        report: report({
          automations_translated: 0,
          paid_subs_imported: 0,
          automations_unsupported: [
            {
              name: "Lifecycle campaign",
              reason: "Workflow definition requires rebuild review.",
            },
          ],
          resource_completeness: [
            {
              resource: "automations",
              label: "Customer.io workflows",
              source_total: 1,
              imported: 1,
              supported: true,
              status: "preserved_for_rebuild",
            },
          ],
        }),
        onBack: vi.fn(),
        onCommit: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "Email-addressable cio_id profiles",
      );
      expect(document.body.textContent).toContain(
        "Frozen segment/topic memberships",
      );
      expect(document.body.textContent).toContain("Workflow rebuild records");
      expect(document.body.textContent).toContain(
        "Sent email newsletter archive",
      );
      expect(document.body.textContent).toContain(
        "Workflow/channel/ecosystem evidence",
      );
      expect(document.body.textContent).toContain(
        "Customer.io workflows to rebuild or retire",
      );
      expect(document.body.textContent).not.toContain("Paid subs");
    } finally {
      act(() => root.unmount());
    }
  });
});
