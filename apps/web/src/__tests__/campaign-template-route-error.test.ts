// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { handleCampaignTemplateRouteError } from "@/lib/campaign-template-route-error";

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => navigation);

const NOT_FOUND = new Error("NEXT_NOT_FOUND");
const REDIRECTED = new Error("NEXT_REDIRECT");

beforeEach(() => {
  vi.clearAllMocks();
  navigation.notFound.mockImplementation(() => {
    throw NOT_FOUND;
  });
  navigation.redirect.mockImplementation(() => {
    throw REDIRECTED;
  });
});

describe("campaign template route errors", () => {
  it("redirects 401, maps only 404 to not-found, and rethrows retryable errors", () => {
    expect(() =>
      handleCampaignTemplateRouteError(
        new ApiError("signed out", 401),
        "/app/templates/template-1/preview",
      ),
    ).toThrow(REDIRECTED);
    expect(navigation.redirect).toHaveBeenCalledWith(
      "/login?next=%2Fapp%2Ftemplates%2Ftemplate-1%2Fpreview",
    );

    expect(() =>
      handleCampaignTemplateRouteError(
        new ApiError("missing", 404),
        "/app/templates/template-1",
      ),
    ).toThrow(NOT_FOUND);
    expect(navigation.notFound).toHaveBeenCalledOnce();

    const unavailable = new ApiError("temporarily unavailable", 503);
    expect(() =>
      handleCampaignTemplateRouteError(
        unavailable,
        "/app/templates/template-1/edit",
      ),
    ).toThrow(unavailable);
    expect(navigation.notFound).toHaveBeenCalledOnce();

    const forbidden = new ApiError("forbidden", 403);
    expect(() =>
      handleCampaignTemplateRouteError(
        forbidden,
        "/app/templates/template-1",
      ),
    ).toThrow(forbidden);
    expect(navigation.notFound).toHaveBeenCalledOnce();
  });

  it("is used by detail, edit, and preview routes", () => {
    for (const relativePath of [
      "src/app/(dashboard)/app/templates/[id]/page.tsx",
      "src/app/(dashboard)/app/templates/[id]/edit/page.tsx",
      "src/app/(dashboard)/app/templates/[id]/preview/page.tsx",
    ]) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      expect(source).toContain("handleCampaignTemplateRouteError(error");
    }
  });
});
