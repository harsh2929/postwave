// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { metadata as blogMetadata } from "@/app/(marketing)/blog/page";
import { metadata as changelogMetadata } from "@/app/(marketing)/changelog/page";
import { metadata as customersMetadata } from "@/app/(marketing)/customers/page";
import PricingPage, {
  metadata as pricingMetadata,
} from "@/app/(marketing)/pricing/page";
import { metadata as beehiivMetadata } from "@/app/(marketing)/vs/beehiiv/page";
import { metadata as convertKitMetadata } from "@/app/(marketing)/vs/convertkit/page";
import { metadata as mailchimpMetadata } from "@/app/(marketing)/vs/mailchimp/page";
import { metadata as mailerLiteMetadata } from "@/app/(marketing)/vs/mailerlite/page";
import { metadata as sendyMetadata } from "@/app/(marketing)/vs/sendy/page";
import { metadata as substackMetadata } from "@/app/(marketing)/vs/substack/page";
import { metadata as vsMetadata } from "@/app/(marketing)/vs/page";
import { metadata as statusMetadata } from "@/app/(public)/status/page";
import ForgeHomePage from "@/app/forge/page";
import { buildProductJsonLd } from "@/components/marketing/comparison-page";
import { MCP_CATEGORY_COUNT, MCP_TOOL_COUNT } from "@/lib/mcp-catalog-stats";
import toolsData from "@/lib/mcp-tools.json";
import { publicSiteOrigin } from "@/lib/site-url";

function canonical(metadata: Metadata): string | undefined {
  const value = metadata.alternates?.canonical;
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return value?.url.toString();
}

async function render(element: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

describe("public marketing truth", () => {
  it("derives canonical URLs from the configured public-site origin", () => {
    const site = publicSiteOrigin();
    const cases: Array<[Metadata, string]> = [
      [blogMetadata, "/blog"],
      [changelogMetadata, "/changelog"],
      [customersMetadata, "/customers"],
      [pricingMetadata, "/pricing"],
      [statusMetadata, "/status"],
      [vsMetadata, "/vs"],
      [mailchimpMetadata, "/vs/mailchimp"],
      [substackMetadata, "/vs/substack"],
      [beehiivMetadata, "/vs/beehiiv"],
      [convertKitMetadata, "/vs/convertkit"],
      [mailerLiteMetadata, "/vs/mailerlite"],
      [sendyMetadata, "/vs/sendy"],
    ];

    for (const [metadata, path] of cases) {
      expect(canonical(metadata)).toBe(`${site}${path}`);
    }
    expect(
      buildProductJsonLd({
        competitor: "Example",
        slug: "example",
        description: "Example",
      }).url,
    ).toBe(`${site}/vs/example`);
  });

  it("labels customer content as illustrative and omits invented proof", () => {
    // JsonLd deliberately reads Next request headers at render time, so this
    // source-level public-copy test must not manufacture a request context.
    const source = readFileSync(
      new URL("../app/(marketing)/customers/page.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("illustrative workflows");
    for (const inventedClaim of [
      "Lantern Field",
      "Frame &amp; Loop",
      "Harbor Provisions",
      "Open rate +12%",
      "Tooling spend",
      "Spam placement 0%",
      "Trusted by writers",
    ]) {
      expect(source).not.toContain(inventedClaim);
    }
  });

  it("renders the provisional catalog without opening paid checkout", async () => {
    const html = await render(<PricingPage />);

    expect(html).toContain("Sandbox");
    expect(html).toContain("Launch");
    expect(html).toContain("Growth");
    expect(html).toContain("Scale");
    expect(html).toContain("Predictable plans. Hard limits. No surprise bill.");
    expect(html).toContain(
      "Self-serve checkout is closed during production qualification",
    );
    expect(html).not.toContain("Continue to Stripe");
    expect(html).not.toContain("Dedicated IP");
    expect(html).not.toContain("Multi-publication");
    expect(html).not.toContain("Self-host engine");
  });

  it("derives Forge counts from the catalog and labels the transcript honestly", async () => {
    const categories = new Set(toolsData.map((tool) => tool.category)).size;
    expect(MCP_TOOL_COUNT).toBe(toolsData.length);
    expect(MCP_CATEGORY_COUNT).toBe(categories);

    const html = (await render(<ForgeHomePage />)).replaceAll("<!-- -->", "");
    expect(html).toContain(
      `${toolsData.length} source-candidate definitions across ${categories} categories`,
    );
    expect(html).toContain("scripted example");
    expect(html).not.toContain(">live<");
  });
});
