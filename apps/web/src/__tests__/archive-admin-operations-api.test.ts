// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

import {
  ArchiveContractError,
  ArchiveInputError,
  getArchiveIssuePreview,
  getArchiveStats,
  listArchiveIssues,
  parseArchiveIssuePage,
  parseArchiveIssuePreview,
  parseArchiveStats,
  unpublishArchiveIssue,
} from "@/lib/archive-admin-api";

const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000002";
const OPERATION_ID = "00000000-0000-4000-8000-000000000003";

function issue(overrides: Record<string, unknown> = {}) {
  return {
    slug: "august-update",
    subject: "August update",
    excerpt: "What shipped this month.",
    publishedAt: "2026-08-29T09:30:00Z",
    pinned: false,
    campaignId: CAMPAIGN_ID,
    viewCount: 12,
    uniqueVisitors: 9,
    ...overrides,
  };
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    ...issue(),
    htmlBody: "<main>\n<h1>August update</h1>\n</main>",
    metaDescription: "Monthly product update",
    canonicalUrl: "https://example.test/august-update",
    ...overrides,
  };
}

describe("authenticated archive operations API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends bounded search and cursor inputs with the query abort signal", async () => {
    const signal = new AbortController().signal;
    apiMocks.get.mockResolvedValueOnce({
      items: [issue()],
      nextCursor: "v2:opaque-cursor",
    });

    await expect(
      listArchiveIssues({
        cursor: "v2:start",
        limit: 25,
        q: "  august  ",
        signal,
      }),
    ).resolves.toEqual({
      items: [issue()],
      nextCursor: "v2:opaque-cursor",
    });
    expect(apiMocks.get).toHaveBeenCalledWith("/api/v1/archive", {
      query: { cursor: "v2:start", limit: 25, q: "august" },
      signal,
    });
  });

  it("rejects malformed, duplicate, oversized, and failure-as-empty pages", () => {
    expect(() => parseArchiveIssuePage({ items: "not-an-array" })).toThrow(
      ArchiveContractError,
    );
    expect(() =>
      parseArchiveIssuePage({ items: [issue(), issue()] }, 25),
    ).toThrow(/duplicate identities/i);
    expect(() =>
      parseArchiveIssuePage({ items: [], nextCursor: "still-more" }),
    ).toThrow(/cannot advance/i);
    expect(() =>
      parseArchiveIssuePage({ items: [issue({ campaignId: "secret" })] }),
    ).toThrow(/campaignId/i);
    expect(() =>
      parseArchiveIssuePage({ items: [issue(), issue({ slug: "other" })] }, 1),
    ).toThrow(/bounded array/i);
  });

  it("fails locally on unsafe search and cursor inputs", async () => {
    await expect(
      listArchiveIssues({ q: `safe${String.fromCharCode(0)}unsafe` }),
    ).rejects.toBeInstanceOf(ArchiveInputError);
    await expect(
      listArchiveIssues({ cursor: "x".repeat(4_097) }),
    ).rejects.toBeInstanceOf(ArchiveInputError);
    expect(apiMocks.get).not.toHaveBeenCalled();
  });

  it("strictly parses stats instead of turning malformed reads into zeros", async () => {
    apiMocks.get.mockResolvedValueOnce({
      totalIssues: 1,
      pinnedIssues: 0,
      views30d: 12,
      uniqueVisitors30d: 9,
      topIssueSlug: "august-update",
      topIssueSubject: "August update",
      topIssueViews: 12,
      lastPublishedAt: "2026-08-29T09:30:00Z",
    });

    await expect(getArchiveStats()).resolves.toMatchObject({
      totalIssues: 1,
      topIssueSlug: "august-update",
    });
    expect(() =>
      parseArchiveStats({
        totalIssues: "1",
        pinnedIssues: 0,
        views30d: 0,
        uniqueVisitors30d: 0,
      }),
    ).toThrow(ArchiveContractError);
    expect(() =>
      parseArchiveStats({
        totalIssues: 1,
        pinnedIssues: 0,
        views30d: 1,
        uniqueVisitors30d: 1,
        topIssueSlug: "august-update",
      }),
    ).toThrow(/incomplete/i);
  });

  it("loads previews online-only, without retries, and binds the response to the slug", async () => {
    const signal = new AbortController().signal;
    apiMocks.get.mockResolvedValueOnce(preview());

    const result = await getArchiveIssuePreview("august-update", signal);
    expect(result).toMatchObject({
      slug: "august-update",
      campaignId: CAMPAIGN_ID,
    });
    expect(result).not.toHaveProperty("authorName");
    expect(result).not.toHaveProperty("canonicalUrl");
    expect(apiMocks.get).toHaveBeenCalledWith(
      "/api/v1/admin/archive/issues/august-update/preview",
      { requireOnline: true, maxAttempts: 1, signal },
    );
    expect(() =>
      parseArchiveIssuePreview(
        preview({ slug: "different-issue" }),
        "august-update",
      ),
    ).toThrow(/did not match/i);
    expect(() =>
      parseArchiveIssuePreview(
        preview({ htmlBody: "x".repeat(1_500_001) }),
        "august-update",
      ),
    ).toThrow(/htmlBody/i);
  });

  it("uses an explicit idempotency key and accepts only a positive receipt", async () => {
    const signal = new AbortController().signal;
    apiMocks.post.mockResolvedValueOnce({ ok: true });

    await expect(
      unpublishArchiveIssue({
        campaignId: CAMPAIGN_ID,
        idempotencyKey: OPERATION_ID,
        signal,
      }),
    ).resolves.toEqual({ ok: true });
    expect(apiMocks.post).toHaveBeenCalledWith(
      `/api/v1/campaigns/${CAMPAIGN_ID}/unpublish-archive`,
      undefined,
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: OPERATION_ID,
        signal,
      },
    );

    apiMocks.post.mockResolvedValueOnce({ ok: false });
    await expect(
      unpublishArchiveIssue({
        campaignId: CAMPAIGN_ID,
        idempotencyKey: OPERATION_ID,
      }),
    ).rejects.toThrow(/did not confirm success/i);
  });
});
