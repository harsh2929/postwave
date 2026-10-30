// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VerificationReportCard } from "@/app/(dashboard)/app/migrations/[jobId]/verification-report-card";
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

function activeCampaignReport(): VerificationReport {
  return {
    subscribers_imported: 100,
    suppression_list_size: 3,
    custom_fields_mapped: [],
    custom_fields_unmapped: [],
    segments_translated: 4,
    segments_with_warnings: [],
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
    paid_subs_imported: 0,
    archive_imported: 10,
    source_archive_imported: 12,
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
    data_loss_estimate_pct: 0,
  };
}

describe("VerificationReportCard", () => {
  it("labels ActiveCampaign automations as rebuild review", () => {
    const root = render(
      createElement(VerificationReportCard, {
        report: activeCampaignReport(),
        source: "activecampaign",
      }),
    );

    try {
      expect(document.body.textContent).toContain("Automation rebuilds");
      expect(document.body.textContent).not.toContain(
        "Automations we couldn't translate",
      );

      const showButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Show full report") === true,
      );
      if (!(showButton instanceof HTMLButtonElement)) {
        throw new Error("Show full report button not found");
      }
      act(() => {
        showButton.click();
      });

      expect(document.body.textContent).toContain(
        "Automation rebuilds to review",
      );
      expect(document.body.textContent).not.toContain(
        "Automations we couldn't translate",
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("labels Beehiiv snapshots, rebuild records, premium metadata, and zero billing objects honestly", () => {
    const report = activeCampaignReport();
    report.resource_completeness = [
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
        source_total: 20,
        imported: 20,
        supported: true,
        status: "imported_runtime",
      },
    ];
    const root = render(
      createElement(VerificationReportCard, {
        report,
        source: "beehiiv",
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "Frozen segment/list snapshots",
      );
      expect(document.body.textContent).toContain("Automation rebuild records");
      expect(document.body.textContent).toContain(
        "Premium memberships (metadata)",
      );
      expect(document.body.textContent).toContain(
        "Stripe billing objects imported",
      );
      expect(document.body.textContent).not.toContain("Paid subs");

      const showButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Show full report") === true,
      );
      if (!(showButton instanceof HTMLButtonElement)) {
        throw new Error("Show full report button not found");
      }
      act(() => showButton.click());
      expect(document.body.textContent).toContain(
        "Beehiiv automations to rebuild or retire",
      );
      expect(document.body.textContent).not.toContain(
        "Automations we couldn't translate",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("separates Klaviyo email campaign rows from SMS/push source-archive evidence", () => {
    const report = activeCampaignReport();
    report.automations_unsupported = [
      {
        name: "Welcome flow",
        reason: "Executable flow graph requires rebuild review.",
      },
    ];
    report.resource_completeness = [
      {
        resource: "automations",
        label: "Klaviyo flows",
        source_total: 1,
        imported: 1,
        supported: true,
        status: "preserved_for_rebuild",
      },
    ];
    const root = render(
      createElement(VerificationReportCard, {
        report,
        source: "klaviyo",
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

      const showButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Show full report") === true,
      );
      if (!(showButton instanceof HTMLButtonElement)) {
        throw new Error("Show full report button not found");
      }
      act(() => showButton.click());
      expect(document.body.textContent).toContain(
        "Klaviyo flows to rebuild or waive",
      );
      expect(document.body.textContent).not.toContain(
        "Automations we couldn't translate",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("labels Customer.io immutable profiles, frozen memberships, newsletters, and rebuild evidence honestly", () => {
    const report = activeCampaignReport();
    report.automations_unsupported = [
      {
        name: "Lifecycle campaign",
        reason: "Workflow definition requires rebuild review.",
      },
    ];
    report.resource_completeness = [
      {
        resource: "automations",
        label: "Customer.io workflows",
        source_total: 1,
        imported: 1,
        supported: true,
        status: "preserved_for_rebuild",
      },
    ];
    const root = render(
      createElement(VerificationReportCard, {
        report,
        source: "customerio",
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
        "Paid subscriptions (not imported)",
      );

      const showButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Show full report") === true,
      );
      if (!(showButton instanceof HTMLButtonElement)) {
        throw new Error("Show full report button not found");
      }
      act(() => showButton.click());
      expect(document.body.textContent).toContain(
        "Customer.io workflows to rebuild or retire",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
