// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  publicReleaseApprovalReference,
  publicReleaseApproved,
} from "@/lib/public-release";
import { dynamic as robotsRendering } from "@/app/robots";
import { dynamic as sitemapRendering } from "@/app/sitemap";

describe("public release approval", () => {
  it("keeps metadata publication controls runtime-evaluated", () => {
    expect(robotsRendering).toBe("force-dynamic");
    expect(sitemapRendering).toBe("force-dynamic");
  });

  it.each([
    undefined,
    "",
    "approved:",
    "approved:short",
    "yes:RELEASE-2026-07",
    " approved : RELEASE-2026-07 ",
  ])("fails closed for %j", (value) => {
    expect(publicReleaseApproved(value)).toBe(false);
    expect(publicReleaseApprovalReference(value)).toBeNull();
  });

  it("returns a sufficiently specific approved release record", () => {
    expect(publicReleaseApprovalReference("  approved:RELEASE-2026-07  ")).toBe(
      "RELEASE-2026-07",
    );
    expect(publicReleaseApproved("approved:RELEASE-2026-07")).toBe(true);
  });
});
