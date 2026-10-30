import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseArchiveIssuePreview,
  parseArchivePage,
  parseArchiveTenantSettings,
} from "./archiveContracts";
import { WireShapeError } from "./deliverabilityContracts";

describe("parseArchivePage", () => {
  it("keeps pinned / viewCount / uniqueVisitors that the old type dropped", () => {
    const page = parseArchivePage({
      items: [
        {
          slug: "july",
          subject: "July",
          pinned: true,
          viewCount: 12,
          uniqueVisitors: 9,
        },
      ],
      nextCursor: "abc",
    });
    expect(page.items[0]).toMatchObject({
      pinned: true,
      viewCount: 12,
      uniqueVisitors: 9,
    });
    expect(page.nextCursor).toBe("abc");
  });

  it("drops rows with no slug — an unlinkable issue is not renderable", () => {
    const page = parseArchivePage({ items: [{ subject: "orphan" }] });
    expect(page.items).toHaveLength(0);
  });

  it("returns a null cursor at the end of the list", () => {
    expect(parseArchivePage({ items: [] }).nextCursor).toBeNull();
    expect(parseArchivePage([{ slug: "a" }]).nextCursor).toBeNull();
  });

  it("clamps a negative view count", () => {
    const page = parseArchivePage([{ slug: "a", viewCount: -5 }]);
    expect(page.items[0]?.viewCount).toBe(0);
  });
});

describe("parseArchiveTenantSettings", () => {
  it("reads the resolver's own columns", () => {
    expect(
      parseArchiveTenantSettings({
        tenant_archive_slug: " acme-news ",
        archive_domain: "news.acme.com",
        archive_title: "Acme Weekly",
      }),
    ).toEqual({
      tenantArchiveSlug: "acme-news",
      archiveDomain: "news.acme.com",
      archiveTitle: "Acme Weekly",
    });
  });

  it("throws on a non-object envelope instead of inventing empty settings", () => {
    expect(() => parseArchiveTenantSettings([])).toThrow(WireShapeError);
  });
});

describe("parseArchivePage — campaignId", () => {
  it("carries the campaign id the unpublish route takes as its path param", () => {
    const page = parseArchivePage([
      { slug: "july", campaignId: " 9f1c-uuid " },
    ]);
    expect(page.items[0]?.campaignId).toBe("9f1c-uuid");
  });

  it("reports an ABSENT campaign id as empty, never as a usable value", () => {
    // archive.IssueSummary marks it `omitempty`, so an older server simply
    // omits it. The screen must be able to tell "cannot unpublish this row"
    // apart from "unpublish campaign undefined".
    const page = parseArchivePage([{ slug: "july" }]);
    expect(page.items[0]?.campaignId).toBe("");
    expect(parseArchivePage([{ slug: "j", campaignId: 42 }]).items[0]
      ?.campaignId).toBe("");
  });
});

describe("parseArchiveIssuePreview", () => {
  it("reads the admin detail projection, htmlBody included", () => {
    expect(
      parseArchiveIssuePreview({
        slug: "july",
        subject: "July issue",
        htmlBody: "<p>Hi</p>",
        publishedAt: "2026-07-01T00:00:00Z",
        pinned: true,
        excerpt: "A summary",
        authorName: "Ada",
        metaDescription: "meta",
        canonicalUrl: "https://x.test/july",
        campaignId: "abc",
      }),
    ).toEqual({
      slug: "july",
      subject: "July issue",
      htmlBody: "<p>Hi</p>",
      publishedAt: "2026-07-01T00:00:00Z",
      pinned: true,
      excerpt: "A summary",
      authorName: "Ada",
      metaDescription: "meta",
      canonicalUrl: "https://x.test/july",
      campaignId: "abc",
    });
  });

  it("defaults the omitempty SEO fields to empty strings, not undefined", () => {
    const preview = parseArchiveIssuePreview({ slug: "july" });
    expect(preview.authorName).toBe("");
    expect(preview.canonicalUrl).toBe("");
    expect(preview.htmlBody).toBe("");
    expect(preview.pinned).toBe(false);
  });

  it("throws rather than render a preview with no identity", () => {
    expect(() => parseArchiveIssuePreview({ subject: "no slug" })).toThrow(
      WireShapeError,
    );
    expect(() => parseArchiveIssuePreview("boom")).toThrow(WireShapeError);
  });
});

describe("archive verb coverage", () => {
  /**
   * WHAT THIS USED TO ASSERT, AND WHY IT WAS WORSE THAN NOTHING.
   *
   * The previous version checked that four hook names appeared in the source:
   * unpublish, publish, pin, unpin — "so the archive verb set matches the
   * server's". It passed for a year while THREE of the four had no caller, and
   * one of them could never have worked at all.
   *
   * `useArchiveWrite` posts with NO BODY. `AdminPublish` (archive.go) decodes a
   * `PublishInput`, answers 422 `slug_required` on an empty slug, and then
   * validates excerpt, meta description, author name, OG image, hero image and
   * canonical URL. `usePublishArchiveIssue` would have failed on the first
   * check of every call it ever made.
   *
   * An existence check cannot see that. It proves a symbol is present, which is
   * the one thing nobody doubted — and by proving it, it made a broken function
   * look like coverage.
   *
   * So the assertions below check the two things that actually constrain the
   * code: every verb mobile ships is body-less, and every verb mobile ships is
   * CALLED by a screen.
   */
  const hooksSource = () =>
    readFileSync(join(__dirname, "..", "hooks", "useArchiveOps.ts"), "utf8");

  /**
   * Comments stripped. The file NAMES `publish-archive` in order to explain why
   * it is gone, so a raw substring check matches the explanation and reports
   * the opposite of the truth — the exact trap that bit the StepCanvas
   * drag-layer guard in this same programme.
   */
  const hooksCode = () =>
    hooksSource()
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/.*$/gmu, "");

  /** Every non-test source file, so "is it called?" is answered honestly. */
  function appSources(): string {
    const roots = [
      join(__dirname, "..", "..", "app"),
      join(__dirname, "..", "..", "src"),
    ];
    const parts: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!/\.tsx?$/u.test(entry.name) || entry.name.includes(".test.")) continue;
        if (abs.endsWith(join("hooks", "useArchiveOps.ts"))) continue;
        parts.push(readFileSync(abs, "utf8"));
      }
    };
    for (const root of roots) walk(root);
    return parts.join("\n");
  }

  /** The verbs mobile ships. Each takes NO body server-side. */
  const SHIPPED = [
    "useUnpublishArchiveIssue",
    "usePinArchiveIssue",
    "useUnpinArchiveIssue",
  ];

  it("reads real sources, and the comment strip leaves real code behind", () => {
    expect(hooksSource().length).toBeGreaterThan(1_000);
    expect(hooksCode().length).toBeGreaterThan(500);
    expect(hooksCode()).toContain("useArchiveWrite");
    expect(appSources().length).toBeGreaterThan(100_000);
    // The file must still SAY why publish is absent, even though the
    // assertion below deliberately ignores prose.
    expect(hooksSource()).toContain("NO usePublishArchiveIssue");
  });

  it("every shipped archive verb is actually CALLED by a screen", () => {
    // The assertion the old existence check could not make, and the one that
    // would have caught three dead hooks.
    const app = appSources();
    for (const hook of SHIPPED) {
      expect(
        app.includes(hook),
        `${hook} is exported and nothing calls it — a verb the phone cannot reach is not coverage`,
      ).toBe(true);
    }
  });

  it("ships no archive verb whose endpoint demands a request body", () => {
    // `useArchiveWrite` sends none, so a verb pointing at a body-required
    // endpoint is broken on arrival rather than merely unwired.
    const source = hooksCode();
    // The QUOTED verb literal, not a bare substring: "unpublish-archive"
    // contains "publish-archive", so the loose needle matched the verb that is
    // supposed to be here and reported the file as broken.
    expect(
      source.includes('"publish-archive"'),
      "publish-archive requires a validated PublishInput body (slug, excerpt, SEO fields) and useArchiveWrite sends none. See the note in useArchiveOps.",
    ).toBe(false);
    // ...and prove the needle can still find the verb that IS present, so a
    // typo in the literal cannot make this assertion vacuously true.
    expect(source.includes('"archive/pin"')).toBe(true);
    expect(source).toContain('"archive/pin"');
    expect(source).toContain('"archive/unpin"');
  });

  it("builds each archive path from an encoded campaign id", () => {
    const source = readFileSync(
      join(__dirname, "..", "hooks", "useArchiveOps.ts"),
      "utf8",
    );
    // An empty id yields /api/v1/campaigns//publish-archive, which chi resolves
    // to a different route — the trap this file already documents.
    expect(source).toContain("encodeURIComponent(input.campaignId)");
    expect(source).toContain("ArchiveCampaignUnknownError()");
  });
});
