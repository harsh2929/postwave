import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AuthFailedBanner,
  SourceUnavailableBanner,
} from "../../components/migration/MigrationErrorBanners";

describe("desktop migration AuthFailedBanner", () => {
  it("can label ActiveCampaign authentication recovery as API token plus account URL", () => {
    const html = renderToStaticMarkup(
      createElement(AuthFailedBanner, {
        onReenter: vi.fn(),
        credentialLabel: "API token + account URL",
      }),
    );

    expect(html).toContain("Re-enter your API token + account URL");
    expect(html).toContain("Re-enter API token + account URL");
    expect(html).not.toContain("API key");
  });

  it("can label HubSpot authentication recovery as private app access token", () => {
    const html = renderToStaticMarkup(
      createElement(AuthFailedBanner, {
        onReenter: vi.fn(),
        credentialLabel: "private app access token",
      }),
    );

    expect(html).toContain("Re-enter your private app access token");
    expect(html).toContain("Re-enter private app access token");
    expect(html).not.toContain("API key");
  });

  it("does not claim a source-unavailable commit is empty or auto-resuming", () => {
    const html = renderToStaticMarkup(
      createElement(SourceUnavailableBanner, { sourceLabel: "Mailchimp" }),
    );

    expect(html).toContain("current run has stopped");
    expect(html).toContain("tracked partial writes");
    expect(html).not.toContain("resume automatically");
    expect(html).not.toContain("Nothing was committed");
  });
});
