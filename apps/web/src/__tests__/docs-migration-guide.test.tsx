import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import MigrationGuidePage, {
  generateMetadata,
} from "@/app/(docs)/docs/migrations/[source]/page";

vi.mock("@/components/docs/CodeBlock", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

describe("migration docs guide", () => {
  it("documents Mailchimp OAuth, audience scope, Classic Automations, and Journey limits", async () => {
    const html = renderToStaticMarkup(
      await MigrationGuidePage({
        params: Promise.resolve({ source: "mailchimp" }),
      }),
    );

    expect(html).toContain("Authentication: <strong>OAuth</strong>");
    expect(html).toContain(
      "validated Classic welcome-series subset as paused runtime records",
    );
    expect(html).toContain(
      "Customer Journey / Automation Flow execution graphs",
    );
    expect(html).toContain("selected_audience_ids");
    expect(html).toContain("recorded before-images");
    expect(html).not.toContain("Mailchimp API key");
    expect(html).not.toContain("Customer Journeys as paused Moosewave");
    expect(html).not.toContain("Every committed migration creates a snapshot");
  });

  it("documents ActiveCampaign as a controlled automation-rebuild cutover", async () => {
    const params = Promise.resolve({ source: "activecampaign" });
    const html = renderToStaticMarkup(await MigrationGuidePage({ params }));
    const metadata = await generateMetadata({
      params: Promise.resolve({ source: "activecampaign" }),
    });

    expect(html).toContain("API token + account API URL");
    expect(html).toContain(
      "Automation summaries plus available blocks, goals, linked campaigns, and SMS relationships as rebuild/review definitions",
    );
    expect(html).toContain("Executable ActiveCampaign automations");
    expect(html).toContain(
      "Saved segments and automations appear as rebuild review inventory",
    );
    expect(html).toContain("rollback rehearsal");
    expect(html).toContain("API-token reset/disconnect evidence");
    expect(html).toContain("Missing account API URL");
    expect(html).toContain("Token rejected by ActiveCampaign");
    expect(html).toContain("Automation rebuild required");
    expect(html).toContain("API URL rejected before connection");
    expect(html).toContain("Contacts remain unconfirmed");
    expect(html).toContain("/audiences");
    expect(html).toContain("/segmentsV2");
    expect(html).toContain("fixed overlap windows");
    expect(html).toContain("binds later reconnect/cutover work to that same account");
    expect(html).toContain("consent/exclusion cutover evidence");
    expect(html).not.toContain("activecampaign_missing_api_url");
    expect(html).not.toContain("activecampaign_auth_failed");
    expect(html).not.toContain("activecampaign_partial_automation");
    expect(html).not.toContain("Moosewave runtime sequence");
    expect(html).not.toContain("API credentials follow");
    expect(html).not.toContain(
      "Automations and Customer Journeys as paused Moosewave automation records",
    );
    expect(metadata.description).toContain("automation rebuild evidence");
    expect(metadata.description).toContain("final-delta cutover");
  });

  it("documents HubSpot as a controlled CRM bridge cutover", async () => {
    const params = Promise.resolve({ source: "hubspot" });
    const html = renderToStaticMarkup(await MigrationGuidePage({ params }));
    const metadata = await generateMetadata({
      params: Promise.resolve({ source: "hubspot" }),
    });

    expect(html).toContain("Private app token");
    expect(html).toContain("HubSpot remains the CRM system of record");
    expect(html).toContain("subscriptions-definition-read");
    expect(html).toContain("subscriptions-status-read");
    expect(html).toContain("Enterprise-only batch subscription scopes");
    expect(html).toContain("at least seven days");
    expect(html).toContain("authoritative full snapshot");
    expect(html).toContain("NOT_SPECIFIED");
    expect(html).toContain("rollback");
    expect(html).toContain("rotate/revoke the external token");
    expect(html).not.toContain("ActiveCampaign overlap window");
    expect(metadata.description).toContain("HubSpot contacts");
    expect(metadata.description).toContain("final-delta cutover");
    expect(metadata.description).toContain("private-app-token cleanup");
  });
});
