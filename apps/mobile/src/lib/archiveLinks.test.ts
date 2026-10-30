import { describe, expect, it } from "vitest";

import {
  ARCHIVE_PUBLIC_HOST,
  archiveFeedURL,
  archiveIndexBase,
  archiveIssueURL,
  archiveLinkBlockedReason,
} from "./archiveLinks";

describe("archiveIndexBase", () => {
  it("prefers a verified vanity domain over the shared host", () => {
    expect(
      archiveIndexBase({
        archiveDomain: "news.acme.com",
        tenantArchiveSlug: "acme-news",
      }),
    ).toBe("https://news.acme.com");
  });

  it("strips a scheme and trailing slash the operator may have pasted in", () => {
    expect(archiveIndexBase({ archiveDomain: "https://news.acme.com/" })).toBe(
      "https://news.acme.com",
    );
  });

  it("falls back to the public host plus the ARCHIVE slug", () => {
    expect(archiveIndexBase({ tenantArchiveSlug: "acme news" })).toBe(
      `${ARCHIVE_PUBLIC_HOST}/acme%20news`,
    );
  });

  it("returns null when neither is set — never guesses a host", () => {
    expect(archiveIndexBase({})).toBeNull();
    expect(archiveIndexBase(null)).toBeNull();
    expect(archiveIndexBase(undefined)).toBeNull();
    expect(
      archiveIndexBase({ archiveDomain: "   ", tenantArchiveSlug: "  " }),
    ).toBeNull();
  });
});

describe("archiveIssueURL", () => {
  it("builds a vanity-domain issue URL at the host root", () => {
    expect(
      archiveIssueURL({ archiveDomain: "news.acme.com" }, "july-launch"),
    ).toBe("https://news.acme.com/july-launch");
  });

  it("builds a slug-based issue URL under the public host", () => {
    expect(
      archiveIssueURL({ tenantArchiveSlug: "acme-news" }, "july launch"),
    ).toBe(`${ARCHIVE_PUBLIC_HOST}/acme-news/july%20launch`);
  });

  it("refuses without a public archive identity or an issue slug", () => {
    expect(archiveIssueURL({}, "july")).toBeNull();
    expect(archiveIssueURL({ tenantArchiveSlug: "acme-news" }, "  ")).toBeNull();
  });

  it("never accepts the auth workspace slug — only the resolver columns", () => {
    // Regression guard for the original defect: the only inputs this function
    // accepts are `archiveDomain` and `tenantArchiveSlug`.
    const url = archiveIssueURL({ tenantArchiveSlug: "archive-slug" }, "x");
    expect(url).toContain("archive-slug");
    expect(url).not.toContain("/archive/");
  });
});

describe("archiveFeedURL", () => {
  it("uses the API origin and the archive slug", () => {
    expect(
      archiveFeedURL("https://api.moosewave.com/", {
        tenantArchiveSlug: "acme-news",
      }),
    ).toBe("https://api.moosewave.com/api/public/archive/acme-news/feed.xml");
  });

  it("still needs the slug even when a vanity domain exists", () => {
    // The feed is served by the API, which resolves tenant_archive_slug; a
    // vanity host cannot substitute for it.
    expect(
      archiveFeedURL("https://api.moosewave.com", {
        archiveDomain: "news.acme.com",
      }),
    ).toBeNull();
  });

  it("refuses without an API base", () => {
    expect(archiveFeedURL("", { tenantArchiveSlug: "acme-news" })).toBeNull();
  });
});

describe("archiveLinkBlockedReason", () => {
  it("is null once a usable identity is present", () => {
    expect(
      archiveLinkBlockedReason({ tenantArchiveSlug: "acme-news" }),
    ).toBeNull();
  });

  it("distinguishes 'still loading' from 'not configured'", () => {
    expect(archiveLinkBlockedReason(null, { loaded: false })).toContain(
      "Checking",
    );
    expect(archiveLinkBlockedReason(null)).toContain("No public archive");
  });

  it("does not promise 'Checking…' forever when the settings read FAILED", () => {
    // The tenant-settings endpoint is admin-scoped, so a viewer role gets a
    // 403 that never becomes `loaded` — the old copy left the affordance
    // stuck on a sentence that could never come true.
    const reason = archiveLinkBlockedReason(null, {
      loaded: false,
      failed: true,
    });
    expect(reason).not.toContain("Checking");
    expect(reason).toContain("couldn't be read");
  });

  it("still returns null on a failed read when an identity is already known", () => {
    expect(
      archiveLinkBlockedReason(
        { tenantArchiveSlug: "acme-news" },
        { loaded: false, failed: true },
      ),
    ).toBeNull();
  });
});
