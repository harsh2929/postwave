import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import GettingStartedPage from "@/app/(docs)/docs/getting-started/page";
import QuickstartPage from "@/app/(docs)/docs/quickstart/page";

vi.mock("@/components/docs/CodeBlock", () => ({
  CodeBlock: ({ code, caption }: { code: string; caption: string }) => (
    <figure>
      <figcaption>{caption}</figcaption>
      <pre>{code}</pre>
    </figure>
  ),
}));

describe("docs getting started ActiveCampaign migration guidance", () => {
  it("surfaces ActiveCampaign in the docs landing migration paths", () => {
    const html = renderToStaticMarkup(<GettingStartedPage />);

    expect(html).toContain("Switch from ActiveCampaign");
    expect(html).toContain("Migrate from ActiveCampaign");
    expect(html).toContain(
      "ActiveCampaign adds source-event, final-delta, and rebuild-review gates",
    );
    expect(html).not.toContain("migrations from six other ESPs");
    expect(html).not.toContain("OAuth-bound import from another ESP");
  });

  it("uses the ActiveCampaign credential endpoint in the quickstart migration step", () => {
    const html = renderToStaticMarkup(<QuickstartPage />);

    expect(html).toContain(
      "POST /api/v1/migrations/activecampaign/credentials",
    );
    expect(html).toContain("ACTIVECAMPAIGN_API_TOKEN");
    expect(html).toContain("extra");
    expect(html).toContain("api_url");
    expect(html).toContain(
      "ActiveCampaign automations are preserved as rebuild-review evidence",
    );
    expect(html).not.toContain('POST /api/v1/migrations"');
    expect(html).not.toContain('"source": "mailchimp"');
    expect(html).not.toContain("The wizard runs an OAuth flow");
  });
});
