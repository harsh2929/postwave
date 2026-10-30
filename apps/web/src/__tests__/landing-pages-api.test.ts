// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

import { landingPagesApi } from "@/lib/landing-pages-api";

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
});

describe("landing-page version path transport", () => {
  it("keeps page and version identifiers in separate encoded segments", async () => {
    apiMocks.post.mockResolvedValue({});

    await landingPagesApi.restoreVersion("page/team A", 7);

    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/landing-pages/page%2Fteam%20A/versions/7/restore",
      {},
      { requireOnline: true, maxAttempts: 1 },
    );
  });

  it("rejects a non-canonical version before transport", () => {
    expect(() => landingPagesApi.restoreVersion("page-1", 1.5)).toThrow(
      /positive integer/i,
    );
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it("makes every admin mutation online-only and single-attempt", async () => {
    apiMocks.post.mockResolvedValue({});
    apiMocks.patch.mockResolvedValue({});
    apiMocks.delete.mockResolvedValue({});

    await landingPagesApi.create({ name: "Page", slug: "page" });
    await landingPagesApi.update("page-1", { status: "published" });
    await landingPagesApi.archive("page-1");
    await landingPagesApi.createVariant("page-1", { name: "B" });
    await landingPagesApi.updateVariant("page-1", "variant-1", {
      weight: 25,
    });
    await landingPagesApi.deleteVariant("page-1", "variant-1");

    const writeOptions = { requireOnline: true, maxAttempts: 1 };
    expect(apiMocks.post).toHaveBeenNthCalledWith(
      1,
      "/api/v1/landing-pages",
      { name: "Page", slug: "page" },
      writeOptions,
    );
    expect(apiMocks.patch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/landing-pages/page-1",
      { status: "published" },
      writeOptions,
    );
    expect(apiMocks.delete).toHaveBeenNthCalledWith(
      1,
      "/api/v1/landing-pages/page-1",
      writeOptions,
    );
    expect(apiMocks.post).toHaveBeenNthCalledWith(
      2,
      "/api/v1/landing-pages/page-1/variants",
      { name: "B" },
      writeOptions,
    );
    expect(apiMocks.patch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/landing-pages/page-1/variants/variant-1",
      { weight: 25 },
      writeOptions,
    );
    expect(apiMocks.delete).toHaveBeenNthCalledWith(
      2,
      "/api/v1/landing-pages/page-1/variants/variant-1",
      writeOptions,
    );
  });
});
