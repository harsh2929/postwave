import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import FeaturesPage, {
  metadata as featuresMetadata,
} from "@/app/(marketing)/features/page";
import HomePage from "@/app/(marketing)/page";
import MigrationDetailPage, {
  generateMetadata,
  generateStaticParams,
} from "@/app/(marketing)/migrations/[from]/page";
import { alt as migrationsOpenGraphAlt } from "@/app/(marketing)/migrations/opengraph-image";

async function render(element: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

describe("ActiveCampaign marketing migration detail", () => {
  it("publishes controlled-cutover copy instead of generic automation promises", async () => {
    expect(generateStaticParams()).toContainEqual({ from: "activecampaign" });

    const metadata = await generateMetadata({
      params: Promise.resolve({ from: "activecampaign" }),
    });

    expect(metadata.description).toContain("automation rebuild evidence");
    expect(metadata.description).toContain("final delta");

    const html = await render(
      await MigrationDetailPage({
        params: Promise.resolve({ from: "activecampaign" }),
      }),
    );

    expect(html).toContain("API token plus trusted account API URL");
    expect(html).toContain("ActiveCampaign API token and account API URL");
    expect(html).toContain(
      "Automation summaries, blocks, goals, linked campaigns, and SMS relationships as rebuild-review definitions",
    );
    expect(html).toContain("not live runtime activation");
    expect(html).toContain(
      "Will my ActiveCampaign automations migrate to live Moosewave automations?",
    );
    expect(html).toContain("source-event shadowing");
    expect(html).toContain("/audiences");
    expect(html).toContain("/segmentsV2");
    expect(html).toContain("phone-only contacts as review evidence");
    expect(html).toContain("Reconcile channel consent and exclusions");
    expect(html).toContain("source-ID-to-email and tag/list mappings");
    expect(html).toContain("polling cannot prove hard deletions");
    expect(html).toContain("reviewed final source export/audit");
    expect(html).toContain("binds the job to the account returned by ActiveCampaign");
    expect(html).not.toContain(
      "Subscribers, automations, consent records, preserved end-to-end",
    );
    expect(html).not.toContain("PT20M");
    expect(html).not.toContain("20 minutes");
    expect(html).not.toContain("not activated Moosewave sequences");
  });

  it("keeps ActiveCampaign-inclusive marketing promises proof-gated", async () => {
    const home = await render(<HomePage />);
    const features = await render(<FeaturesPage />);

    expect(home).toContain("Dry-run first. Cut over with proof.");
    expect(features).toContain(
      "Move with a dry run first. Cut over with proof.",
    );
    expect(featuresMetadata.description).toContain("verified migrations");
    expect(migrationsOpenGraphAlt).toContain("dry-run report");
    expect(migrationsOpenGraphAlt).toContain("ActiveCampaign");
    expect(migrationsOpenGraphAlt).toContain("HubSpot");

    for (const copy of [home, features, migrationsOpenGraphAlt]) {
      expect(copy).not.toContain("Zero data loss");
      expect(copy).not.toContain("zero data loss");
      expect(copy).not.toContain("Lose nothing");
    }
  });

  it("publishes HubSpot as a CRM bridge with proof gates", async () => {
    expect(generateStaticParams()).toContainEqual({ from: "hubspot" });

    const metadata = await generateMetadata({
      params: Promise.resolve({ from: "hubspot" }),
    });
    expect(metadata.description).toContain("private app token");
    expect(metadata.description).toContain("pilot acceptance");

    const html = await render(
      await MigrationDetailPage({
        params: Promise.resolve({ from: "hubspot" }),
      }),
    );

    expect(html).toContain("Private app token CRM bridge");
    expect(html).toContain("HubSpot remains the CRM system of record");
    expect(html).toContain("HubSpot private app access token");
    expect(html).toContain("source-event replay");
    expect(html).toContain("credential cleanup proof");
    expect(html).not.toContain("HubSpot workflows migrate automatically");
  });
});
