import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MatchHistoryPanel,
  ProviderSnippetsCard,
  buildProviderSnippets,
  formatInboundRouteRelative,
} from "../../components/inbound/InboundRouteDiagnostics";

describe("inbound route diagnostics extraction", () => {
  it("formats reviewed history timestamps deterministically", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    expect(formatInboundRouteRelative(undefined, now)).toBe("never");
    expect(formatInboundRouteRelative("invalid", now)).toBe("invalid");
    expect(formatInboundRouteRelative("2026-07-15T11:58:00.000Z", now)).toBe(
      "2m ago",
    );
    expect(formatInboundRouteRelative("2026-07-13T12:00:00.000Z", now)).toBe(
      "2d ago",
    );
  });

  it("builds all provider instructions against the configured API host", () => {
    const snippets = buildProviderSnippets("tenant-inbox");
    expect(snippets.map((snippet) => snippet.id)).toEqual([
      "postmark",
      "mailgun",
      "ses",
    ]);
    for (const snippet of snippets) {
      expect(snippet.body).toContain("/api/public/inbound-email/tenant-inbox");
      expect(snippet.body).toContain("X-Postwave-Inbound-Signature");
    }
    expect(snippets[0].body).toContain("REJECTS any unsigned request with 401");
  });

  it("renders provider tabs, copy controls, and safe external links", () => {
    const html = renderToStaticMarkup(
      <ProviderSnippetsCard slug="tenant-inbox" />,
    );
    expect(html).toContain("Provider setup snippets");
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Postmark");
    expect(html).toContain("Copy");
    expect(html).toMatch(/rel="(?=[^"]*noopener)(?=[^"]*noreferrer)[^"]*"/u);
  });

  it("preserves the explicit initial match-history loading state", () => {
    expect(
      renderToStaticMarkup(<MatchHistoryPanel routeId="route-1" />),
    ).toContain("Loading history…");
  });
});
