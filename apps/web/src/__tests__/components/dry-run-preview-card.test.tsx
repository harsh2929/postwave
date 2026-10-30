// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DryRunPreviewCard } from "@/app/(dashboard)/app/migrations/_dry-run-preview";
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
    subscribers_imported: 1200,
    suppression_list_size: 18,
    custom_fields_mapped: [],
    custom_fields_unmapped: [],
    segments_translated: 12,
    segments_with_warnings: [],
    automations_translated: 0,
    automations_unsupported: [
      {
        name: "ActiveCampaign automation 1",
        reason:
          "ActiveCampaign automation source definitions are preserved for rebuild review; non-executable placeholders are not activated as Moosewave runtime automation rows.",
      },
      {
        name: "ActiveCampaign automation 2",
        reason:
          "ActiveCampaign automation source definitions are preserved for rebuild review; non-executable placeholders are not activated as Moosewave runtime automation rows.",
      },
    ],
    paid_subs_imported: 0,
    archive_imported: 22,
    resource_completeness: [
      {
        resource: "automations",
        label: "Automations",
        source_total: 2,
        imported: 0,
        supported: true,
        status: "manual_rebuild_required",
        notes: [
          "Automation records are preserved as rebuild items from source definitions.",
        ],
      },
      {
        resource: "templates",
        label: "Templates and messages",
        source_total: 6,
        imported: 6,
        supported: true,
        status: "preserved_for_rebuild",
        notes: [
          "Message/template inventory is preserved as source archive evidence for rebuild.",
        ],
      },
      {
        resource: "forms",
        label: "Forms",
        source_total: 3,
        imported: 3,
        supported: true,
        status: "preserved_for_rebuild",
        notes: [
          "Recreate hosted and embedded forms in Moosewave before switching capture points.",
        ],
      },
      {
        resource: "sms",
        label: "SMS campaigns and consent",
        source_total: 2,
        imported: 2,
        supported: true,
        status: "preserved_for_rebuild",
        notes: ["SMS campaign inventory is preserved for review."],
      },
      {
        resource: "crm",
        label: "CRM deals and pipelines",
        source_total: 4,
        imported: 4,
        supported: true,
        status: "preserved_for_rebuild",
        notes: [
          "ActiveCampaign CRM records are preserved as read-only context.",
        ],
      },
      {
        resource: "subscribers",
        label: "Contacts",
        source_total: 1200,
        imported: 1200,
        supported: true,
        status: "imported_runtime",
      },
    ],
    data_loss_estimate_pct: 1.2,
  };
}

describe("DryRunPreviewCard", () => {
  it("renders structured source fields as bounded escaped JSON", () => {
    const report = activeCampaignReport();
    report.sample_subscribers = [
      {
        email: "q***@example.test",
        status: "unconfirmed",
        custom_fields: {
          email_status_evidence: { state: "unconfirmed", provider: "csv" },
          labels: ["operations-qa"],
          long_value: "x".repeat(2000),
          unsafe_text: "<script>alert(1)</script>",
        },
      },
    ];
    const root = render(
      createElement(DryRunPreviewCard, {
        jobId: "qa",
        sourceLabel: "CSV upload",
        preview: report,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    try {
      const text = document.body.textContent ?? "";
      expect(text).toContain('"state": "unconfirmed"');
      expect(text).toContain('"operations-qa"');
      expect(text).not.toContain("[object Object]");
      expect(text).toContain("more characters");
      expect(text).not.toContain("x".repeat(2000));
      expect(document.querySelector("script")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("surfaces ActiveCampaign cutover review surfaces before commit", () => {
    const root = render(
      createElement(DryRunPreviewCard, {
        jobId: "job_activecampaign_123",
        sourceLabel: "ActiveCampaign",
        preview: activeCampaignReport(),
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain("Plan review");
      expect(document.body.textContent).toContain("Automation rebuilds");
      expect(document.body.textContent).toContain("2 need rebuild review");
      expect(document.body.textContent).toContain("Cutover review surfaces");
      expect(document.body.textContent).toContain("Automations");
      expect(document.body.textContent).toContain("Templates and messages");
      expect(document.body.textContent).toContain("Forms");
      expect(document.body.textContent).toContain("SMS campaigns and consent");
      expect(document.body.textContent).toContain("CRM deals and pipelines");
      expect(document.body.textContent).not.toContain("Sequences");
      expect(document.body.textContent).not.toContain(
        "will fall back to standard steps",
      );
      expect(document.body.textContent).not.toContain(
        "Mailchimp parity objects",
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("renders a masked sample of how records will land (MIGR-028)", () => {
    const report = activeCampaignReport();
    report.sample_subscribers = [
      {
        email: "a***@example.com",
        status: "enabled",
        tags: ["vip"],
        source_id: "src:1",
        custom_fields: { first_name: "Ada" },
      },
    ];
    const root = render(
      createElement(DryRunPreviewCard, {
        jobId: "job_sample_1",
        sourceLabel: "Mailchimp",
        preview: report,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    try {
      const section = document.querySelector(
        '[data-testid="sample-subscribers"]',
      );
      expect(section).not.toBeNull();
      expect(section?.textContent).toContain("Sample of how records will land");
      expect(section?.textContent).toContain("a***@example.com");
      expect(section?.textContent).toContain("enabled");
      expect(section?.textContent).toContain("vip");
      expect(section?.textContent).toContain("first_name: Ada");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("omits the sample section when no sample rows are present", () => {
    const root = render(
      createElement(DryRunPreviewCard, {
        jobId: "job_nosample_1",
        sourceLabel: "Mailchimp",
        preview: activeCampaignReport(),
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    try {
      expect(
        document.querySelector('[data-testid="sample-subscribers"]'),
      ).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("shows Beehiiv rebuild, snapshot, and billing boundaries before commit", () => {
    const report = activeCampaignReport();
    report.segments_translated = 3;
    report.automations_unsupported = [
      {
        name: "Welcome series",
        reason: "Preserved metadata requires a manual rebuild.",
      },
    ];
    report.resource_completeness = [
      {
        resource: "automations",
        label: "Automation rebuild records",
        source_total: 1,
        imported: 1,
        supported: true,
        status: "preserved_for_rebuild",
      },
      {
        resource: "premium_memberships",
        label: "Premium membership metadata",
        source_total: 42,
        imported: 42,
        supported: true,
        status: "imported_runtime",
      },
      {
        resource: "paid_subs",
        label: "Stripe billing continuity",
        source_total: 42,
        imported: 0,
        supported: false,
        status: "manual_rebuild_required",
      },
    ];

    const root = render(
      createElement(DryRunPreviewCard, {
        jobId: "job_beehiiv_123",
        sourceLabel: "Beehiiv",
        preview: report,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "Frozen segment/list snapshots",
      );
      expect(document.body.textContent).toContain(
        "Beehiiv automation rebuild records",
      );
      expect(document.body.textContent).toContain(
        "1 must be rebuilt or retired",
      );
      expect(document.body.textContent).toContain(
        "Premium memberships (metadata only)",
      );
      expect(document.body.textContent).toContain(
        "42 will be preserved on subscribers",
      );
      expect(document.body.textContent).toContain(
        "Stripe billing is not part of this import",
      );
      expect(document.body.textContent).not.toContain(
        "Paid Stripe subscriptions",
      );
      expect(document.body.textContent).not.toContain("will be linked");
    } finally {
      act(() => root.unmount());
    }
  });

  it("labels supported Mailchimp Classic Automations as paused and unsupported ones as manual review", () => {
    const report = activeCampaignReport();
    report.automations_translated = 1;
    report.automations_unsupported = [
      {
        name: "Unsupported Mailchimp workflow",
        reason: "This workflow requires manual rebuild review.",
      },
    ];
    const root = render(
      createElement(DryRunPreviewCard, {
        jobId: "job_mailchimp_123",
        sourceLabel: "Mailchimp",
        preview: report,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain("Classic Automations");
      expect(document.body.textContent).toContain("1 will be imported paused");
      expect(document.body.textContent).toContain(
        "1 automation requires manual rebuild or review and will not be activated",
      );
      expect(document.body.textContent).not.toContain("Sequences");
      expect(document.body.textContent).not.toContain(
        "fall back to standard steps",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows Customer.io immutable-profile, frozen-audience, workflow, newsletter, and billing boundaries", () => {
    const report = activeCampaignReport();
    report.automations_unsupported = [
      {
        name: "Lifecycle campaign",
        reason: "Preserved for Customer.io workflow rebuild review.",
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
      createElement(DryRunPreviewCard, {
        jobId: "job_customerio_123",
        sourceLabel: "Customer.io",
        preview: report,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "Email-addressable cio_id profiles",
      );
      expect(document.body.textContent).toContain(
        "Frozen segment/topic memberships",
      );
      expect(document.body.textContent).toContain(
        "Customer.io workflow rebuild records",
      );
      expect(document.body.textContent).toContain(
        "1 must be rebuilt or retired",
      );
      expect(document.body.textContent).toContain(
        "Sent email newsletter archive",
      );
      expect(document.body.textContent).toContain(
        "Paid billing is not part of this import",
      );
      expect(document.body.textContent).not.toContain(
        "Paid Stripe subscriptions",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
