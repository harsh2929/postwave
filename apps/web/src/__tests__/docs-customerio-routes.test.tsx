// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import IntegrationPage, {
  generateMetadata as generateIntegrationMetadata,
  generateStaticParams as generateIntegrationStaticParams,
} from "@/app/(docs)/docs/integrations/[integration]/page";
import IntegrationsIndexPage from "@/app/(docs)/docs/integrations/page";
import MigrationGuidePage, {
  generateMetadata as generateMigrationMetadata,
  generateStaticParams as generateMigrationStaticParams,
} from "@/app/(docs)/docs/migrations/[source]/page";
import MigrationsIndexPage from "@/app/(docs)/docs/migrations/page";
import { DOCS_INTEGRATIONS, DOCS_MIGRATION_SOURCES } from "@/lib/docs/catalog";
import { STATIC_DOCS } from "@/lib/docs/search.server";

vi.mock("@/components/docs/CodeBlock", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

describe("Customer.io docs routes", () => {
  it("registers canonical migration and integration routes everywhere navigation is derived", () => {
    expect(generateMigrationStaticParams()).toContainEqual({
      source: "customerio",
    });
    expect(generateIntegrationStaticParams()).toContainEqual({
      integration: "customerio",
    });
    expect(DOCS_MIGRATION_SOURCES).toContainEqual({
      slug: "customerio",
      name: "Customer.io",
    });
    expect(DOCS_INTEGRATIONS).toContainEqual({
      slug: "customerio",
      name: "Customer.io",
    });

    const migrationIndex = renderToStaticMarkup(<MigrationsIndexPage />);
    const integrationIndex = renderToStaticMarkup(<IntegrationsIndexPage />);
    expect(migrationIndex).toContain('href="/docs/migrations/customerio"');
    expect(integrationIndex).toContain('href="/docs/integrations/customerio"');

    expect(STATIC_DOCS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Customer.io migration",
          url: "/docs/migrations/customerio",
        }),
        expect.objectContaining({
          title: "Customer.io integration",
          url: "/docs/integrations/customerio",
        }),
      ]),
    );
  });

  it("renders the migration contract without inventing incremental or executable parity", async () => {
    const html = renderToStaticMarkup(
      await MigrationGuidePage({
        params: Promise.resolve({ source: "customerio" }),
      }),
    );
    const metadata = await generateMigrationMetadata({
      params: Promise.resolve({ source: "customerio" }),
    });

    expect(metadata.alternates).toEqual({
      canonical: "/docs/migrations/customerio",
    });
    expect(metadata.description).toContain("region/workspace-bound");
    expect(metadata.description).toContain("mandatory final full snapshot");
    expect(html).toContain("Authentication: <strong>App API key</strong>");
    expect(html).toContain("immutable Customer.io cio_id identity");
    expect(html).toContain("GET /v1/customers is an email lookup");
    expect(html).toContain(
      "global subscribed + resolved email-channel subscribed/default + applicable topic subscribed/default",
    );
    expect(html).toContain(
      "Sender-specific SMS/WhatsApp /v1/optouts as separate non-email evidence",
    );
    expect(html).toContain("they are not the email-channel preference");
    expect(html).toContain(
      "at least one explicit language=&quot;&quot; default",
    );
    expect(html).toContain("lowest stable content ID");
    expect(html).toContain("multi-default/A-B set with an explicit warning");
    expect(html).toContain("translations are never silently selected");
    expect(html).toContain(
      "raw body/layout plus every variant remain evidence",
    );
    expect(html).toContain("not provider-rendered output");
    expect(html).toContain("exactly one documented {{content}} slot");
    expect(html).toContain(
      "original trigger payloads, audiences, and per-user data",
    );
    expect(html).toContain("Every delta, including the final delta");
    expect(html).toContain("Moosewave never activates one automatically");
    expect(html).toContain(
      "A completed initial import is not cutover certification",
    );
    expect(html).toContain("all six Customer.io reviews");
    expect(html).toContain("source-event monitor is unavailable");
    expect(html).toContain("$CUSTOMERIO_APP_API_KEY");
    expect(html).toContain("$CUSTOMERIO_WORKSPACE_ID");
    expect(html).toContain("$CUSTOMERIO_REGION");
    expect(html).toContain(
      String.raw`-d &quot;{ \&quot;api_key\&quot;: \&quot;$CUSTOMERIO_APP_API_KEY\&quot;`,
    );
    expect(html).not.toContain("Track API writeback is enabled");
    expect(html).not.toContain("live-certified");

    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/app/(docs)/docs/migrations/[source]/page.tsx",
      ),
      "utf8",
    );
    const customerIOBlock = source.slice(
      source.indexOf("  customerio: {"),
      source.indexOf("  convertkit: {"),
    );
    expect(customerIOBlock).toContain(
      String.raw`-d "{ \\\"api_key\\\": \\\"$CUSTOMERIO_APP_API_KEY\\\"`,
    );
    expect(customerIOBlock.split(String.raw`-d "{ \\\"`).length - 1).toBe(4);
    expect(customerIOBlock).not.toMatch(/-d '\{[^\n]*\$(?:CUSTOMERIO|JOB_ID)/);

    const dashboardWizard = readFileSync(
      resolve(
        process.cwd(),
        "src/app/(dashboard)/app/migrations/new/[source]/page.tsx",
      ),
      "utf8",
    );
    expect(dashboardWizard).toContain(
      '"Subscription channel definitions/defaults"',
    );
    expect(dashboardWizard).toContain("d.subscription_channels_count ?? 0");
    expect(dashboardWizard).toContain("multi-default/A-B set");
    expect(dashboardWizard).toContain('{"{{content}}"}');
    expect(dashboardWizard).toMatch(
      /Neither newsletter nor[\s\S]*provider-rendered output/,
    );
    expect(dashboardWizard).toMatch(/original trigger[\s\S]*payloads/);
  });

  it("renders the native provider row as a delegated partial foundation", async () => {
    const html = renderToStaticMarkup(
      await IntegrationPage({
        params: Promise.resolve({ integration: "customerio" }),
      }),
    );
    const metadata = await generateIntegrationMetadata({
      params: Promise.resolve({ integration: "customerio" }),
    });

    expect(metadata.alternates).toEqual({
      canonical: "/docs/integrations/customerio",
    });
    expect(html).toContain("partial provider-row foundation");
    expect(html).toContain("not a native Customer.io data plane");
    expect(html).toContain("customerio_handoff");
    expect(html).toContain("does not independently fetch Profiles");
    expect(html).toContain("no complete incremental profile-change feed");
    expect(html).toContain(
      "repository tests do not replace certification against a real US/EU workspace",
    );
    expect(html).not.toContain("live attestation is complete");
  });
});
