// SPDX-License-Identifier: AGPL-3.0-only
//
// The published archive issue page is the one public, indexable surface the
// product asks prospects and subscribers to open, and its operator-supplied
// hero is the largest above-the-fold element — i.e. the LCP element. It is
// discovered in the document behind three render-blocking stylesheets, so it
// must declare high fetch priority rather than being requested at the default
// priority. This asserts the rendered markup, not the source text.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ArchiveIssueDetail } from "@/lib/archive-api";

const mocks = vi.hoisted(() => ({
  fetchArchiveIssue: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  setRequestLocale: () => undefined,
}));

vi.mock("@/lib/archive-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/archive-api")>();
  return { ...actual, fetchArchiveIssue: mocks.fetchArchiveIssue };
});

const issue: ArchiveIssueDetail = {
  slug: "spring-update",
  subject: "Spring update",
  htmlBody: "<p>Hello there.</p>",
  publishedAt: "2026-03-01T09:00:00Z",
  heroImage: "https://cdn.operator.example/hero.jpg",
} as ArchiveIssueDetail;

describe("public archive hero image", () => {
  it("requests the LCP hero eagerly and at high priority", async () => {
    mocks.fetchArchiveIssue.mockResolvedValue({ kind: "ok", data: issue });
    const { default: ArchiveIssuePage } = await import(
      "@/app/[locale]/archive/[tenant]/[slug]/page"
    );

    const html = renderToStaticMarkup(
      await ArchiveIssuePage({
        params: Promise.resolve({
          tenant: "acme",
          slug: "spring-update",
          locale: "en",
        }),
      }),
    );

    const hero = /<img[^>]*hero\.jpg[^>]*>/.exec(html)?.[0];
    expect(hero).toBeDefined();
    expect(hero).toMatch(/fetchpriority="high"/i);
    expect(hero).toMatch(/loading="eager"/);
  });
});
