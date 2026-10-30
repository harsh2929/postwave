// SPDX-License-Identifier: AGPL-3.0-only
//
// Desktop gaps campaigns-100 (pin/unpin an archive issue) and campaigns-103
// (copy the public index / RSS / sitemap URLs).
//
// The panel test mocks `setArchiveIssuePinned`, so the transport seam — which
// of the two mounted routes each verb actually posts to — is only covered
// here. Pin and unpin are separate routes rather than one route with a flag,
// which makes swapping them a silent, reversible-looking bug.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiModule from "@/lib/api";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, post: mocks.post } };
});

import {
  archiveShareTargets,
  parseArchivePinReceipt,
  setArchiveIssuePinned,
  type ArchiveSettings,
} from "@/lib/archive-admin-api";

const CAMPAIGN_ID = "00000000-0000-4000-8000-0000000000a1";
const OPERATION_ID = "00000000-0000-4000-8000-0000000000a2";

function settings(overrides: Partial<ArchiveSettings> = {}): ArchiveSettings {
  return {
    tenant_archive_slug: "acme-letter",
    archive_domain: "",
    archive_title: "Acme letter",
    archive_tagline: "",
    tips_enabled: false,
    tips_currency: "usd",
    tips_suggested_amounts: [],
    tips_min_amount: 100,
    tips_message: "",
    archive_bar_default_enabled: false,
    view_in_browser_default_enabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("setArchiveIssuePinned", () => {
  it("posts to the pin route and returns the confirmed state", async () => {
    mocks.post.mockResolvedValue({ ok: true, pinned: true });
    await expect(
      setArchiveIssuePinned({
        campaignId: CAMPAIGN_ID,
        pinned: true,
        idempotencyKey: OPERATION_ID,
      }),
    ).resolves.toEqual({ ok: true, pinned: true });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]?.[0]).toBe(
      `/api/v1/campaigns/${CAMPAIGN_ID}/archive/pin`,
    );
    expect(mocks.post.mock.calls[0]?.[1]).toBeUndefined();
    expect(mocks.post.mock.calls[0]?.[2]).toMatchObject({
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: OPERATION_ID,
    });
  });

  it("posts to the unpin route when unfeaturing", async () => {
    mocks.post.mockResolvedValue({ ok: true, pinned: false });
    await setArchiveIssuePinned({
      campaignId: CAMPAIGN_ID,
      pinned: false,
      idempotencyKey: OPERATION_ID,
    });
    expect(mocks.post.mock.calls[0]?.[0]).toBe(
      `/api/v1/campaigns/${CAMPAIGN_ID}/archive/unpin`,
    );
  });

  it("refuses a malformed campaign identity or operation key before transport", async () => {
    for (const options of [
      { campaignId: "not-a-uuid", pinned: true, idempotencyKey: OPERATION_ID },
      { campaignId: CAMPAIGN_ID, pinned: true, idempotencyKey: "not-a-uuid" },
    ]) {
      await expect(setArchiveIssuePinned(options)).rejects.toThrow(
        /malformed/iu,
      );
    }
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("rejects a receipt whose state disagrees with the request", async () => {
    mocks.post.mockResolvedValue({ ok: true, pinned: false });
    await expect(
      setArchiveIssuePinned({
        campaignId: CAMPAIGN_ID,
        pinned: true,
        idempotencyKey: OPERATION_ID,
      }),
    ).rejects.toThrow(/different state than requested/u);
  });
});

describe("parseArchivePinReceipt", () => {
  it("requires an explicit success flag and a matching state", () => {
    expect(parseArchivePinReceipt({ ok: true, pinned: false }, false)).toEqual({
      ok: true,
      pinned: false,
    });
    expect(() => parseArchivePinReceipt({ pinned: true }, true)).toThrow(
      /did not confirm success/u,
    );
    expect(() => parseArchivePinReceipt({ ok: true }, true)).toThrow(
      /must be a boolean/u,
    );
    expect(() => parseArchivePinReceipt("ok", true)).toThrow(
      /must be an object/u,
    );
  });
});

describe("archiveShareTargets", () => {
  it("serves the index from this app and the feeds from the API", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.postwave.test");
    expect(
      archiveShareTargets(settings(), "https://app.postwave.test"),
    ).toEqual({
      indexBase: "https://app.postwave.test/en/archive/acme-letter",
      publicIndexUrl: "https://app.postwave.test/en/archive/acme-letter",
      rssUrl:
        "https://api.postwave.test/api/public/archive/acme-letter/feed.xml",
      sitemapUrl:
        "https://api.postwave.test/api/public/archive/acme-letter/sitemap.xml",
    });
  });

  it("hangs every URL off a vanity host, which the API rewrites at its root", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.postwave.test");
    for (const domain of [
      "letters.acme.test",
      "https://letters.acme.test",
      "https://letters.acme.test/",
    ]) {
      expect(
        archiveShareTargets(
          settings({ archive_domain: domain }),
          "https://app.postwave.test",
        ),
      ).toEqual({
        indexBase: "https://letters.acme.test",
        publicIndexUrl: "https://letters.acme.test",
        rssUrl: "https://letters.acme.test/feed.xml",
        sitemapUrl: "https://letters.acme.test/sitemap.xml",
      });
    }
  });

  it("returns null rather than a dead link when there is no address", () => {
    expect(
      archiveShareTargets(
        settings({ tenant_archive_slug: "", archive_domain: "" }),
        "https://app.postwave.test",
      ),
    ).toBeNull();
  });

  it("refuses a malformed slug or a domain carrying more than a host", () => {
    for (const broken of [
      settings({ tenant_archive_slug: "Not A Slug" }),
      settings({ tenant_archive_slug: "../escape" }),
      settings({
        tenant_archive_slug: "",
        archive_domain: "letters.acme.test/hijack",
      }),
      settings({
        tenant_archive_slug: "",
        archive_domain: "javascript:alert(1)",
      }),
      settings({
        tenant_archive_slug: "",
        archive_domain: "user:pw@letters.acme.test",
      }),
    ]) {
      expect(archiveShareTargets(broken, "https://app.postwave.test")).toBeNull();
    }
  });
});
