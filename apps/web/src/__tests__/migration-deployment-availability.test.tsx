// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { SourceCatalog } from "@/app/(dashboard)/app/migrations/_source-catalog";
import { migrationCapabilityDescription } from "@/lib/migration-capability-copy";
import type { AdapterCapabilities } from "@/lib/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const capability: AdapterCapabilities = {
  source: "mailchimp",
  auth_method: "oauth2",
  supports: {
    subscribers: true,
    segments: false,
    automations: false,
    campaign_archive: false,
    paid_subs: false,
    consent_timestamps: false,
  },
};

describe("migration availability", () => {
  it.each([
    {
      ...capability,
      intake_available: false,
      intake_unavailable_code: "oauth_app_not_configured",
    },
    {
      ...capability,
      source: "csv" as const,
      auth_method: "csv_upload" as const,
      intake_available: false,
      intake_unavailable_code: "durable_upload_storage_unavailable",
    },
  ])("blocks unavailable source entry for $source", async (cap) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <SourceCatalog
            capabilities={[cap]}
            authorityKey="tenant-a"
            canAdmin
          />,
        ),
      );
      expect(
        host.querySelector(`a[href="/app/migrations/new/${cap.source}"]`),
      ).toBeNull();
      expect(
        host
          .querySelector("button[disabled]")
          ?.getAttribute("aria-describedby"),
      ).toContain("availability");
      expect(host.textContent).toMatch(
        /setup is pending|Uploads are unavailable/,
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("allows preview while explaining that commit is unavailable", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <SourceCatalog
            capabilities={[{ ...capability, commit_available: false }]}
            authorityKey="tenant-a"
            canAdmin
          />,
        ),
      );
      expect(
        host.querySelector('a[href="/app/migrations/new/mailchimp"]'),
      ).not.toBeNull();
      expect(host.textContent).toContain("Preview only");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("gives MailerLite its own scope and avoids blanket fidelity claims", () => {
    const copy = migrationCapabilityDescription({
      ...capability,
      source: "mailerlite",
      auth_method: "api_key",
      supports: { ...capability.supports, automation_mode: "rebuild_review" },
    });
    expect(copy).toContain("MailerLite Connect");
    expect(copy).not.toContain("CRM");
    for (const source of [
      "convertkit",
      "brevo",
      "csv",
      "aweber",
      "omnisend",
    ] as const) {
      expect(
        migrationCapabilityDescription({
          ...capability,
          source,
          auth_method:
            source === "csv" || source === "aweber" || source === "omnisend"
              ? "csv_upload"
              : "oauth2",
        }),
      ).not.toMatch(/full-fidelity|everything except/i);
    }
  });
});
