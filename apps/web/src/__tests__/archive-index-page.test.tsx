// SPDX-License-Identifier: AGPL-3.0-only
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ArchiveIndexPage from "@/app/[locale]/archive/[tenant]/page";

const mocks = vi.hoisted(() => ({
  fetchArchiveIndex: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => {
    const messages: Record<string, string> = {
      index_intro: "Every issue",
      rss_link: "RSS feed",
      pinned_section: "Featured",
      recent_section: "Recent issues",
      pagination_label: "Archive pages",
      older_issues: "Older issues",
    };
    return messages[key] ?? key;
  }),
  setRequestLocale: vi.fn(),
}));

vi.mock("@/lib/archive-api", () => ({
  archiveRSSURL: (tenant: string) => `/api/public/archive/${tenant}/rss`,
  fetchArchiveIndex: mocks.fetchArchiveIndex,
}));

describe("ArchiveIndexPage", () => {
  it("passes the cursor through and links to the next archive page", async () => {
    mocks.fetchArchiveIndex.mockResolvedValue({
      kind: "ok",
      data: {
        items: [
          {
            slug: "july-update",
            subject: "July update",
            excerpt: "News",
            publishedAt: "2026-07-01T00:00:00Z",
          },
        ],
        nextCursor: "next+/=",
      },
    });

    const page = await ArchiveIndexPage({
      params: Promise.resolve({ tenant: "acme", locale: "en" }),
      searchParams: Promise.resolve({ cursor: "current+/=" }),
    });
    const html = renderToStaticMarkup(page);

    expect(mocks.fetchArchiveIndex).toHaveBeenCalledWith("acme", {
      cursor: "current+/=",
      limit: 50,
    });
    expect(html).toContain("Older issues");
    expect(html).toContain("cursor=next%2B%2F%3D");
    expect(html).toContain('rel="next"');
  });
});
