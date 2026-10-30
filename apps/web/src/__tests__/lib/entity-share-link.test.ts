// SPDX-License-Identifier: AGPL-3.0-only
//
// Cross-device continuity: the "Copy link" / "Open in app" control surfaced
// on web entity detail views (campaign, subscriber, sequence) must hand out
// a link using the active deployment origin and route-map path. In production
// it also resolves natively via the AASA the web app serves. We test the pure
// helper that backs the component (the component itself is a thin clipboard
// shell) so this stays valid under the node-only vitest environment.

import { describe, it, expect } from "vitest";

import { entityShareUrl } from "@/lib/entity-share-link";

describe("entityShareUrl", () => {
  it("builds the universal link per entity slug", () => {
    expect(entityShareUrl("campaign", "cmp_123")).toBe(
      "https://app.moosewave.com/app/campaigns/cmp_123",
    );
    expect(entityShareUrl("subscriber", "sub_456")).toBe(
      "https://app.moosewave.com/app/subscribers/sub_456",
    );
    expect(entityShareUrl("sequence", "seq_789")).toBe(
      "https://app.moosewave.com/app/sequences/seq_789",
    );
  });

  it("uses the active deployment origin when supplied", () => {
    expect(
      entityShareUrl("campaign", "cmp_123", "https://staging.moosewave.com"),
    ).toBe("https://staging.moosewave.com/app/campaigns/cmp_123");
    expect(
      entityShareUrl("subscriber", "sub_456", "http://localhost:3000"),
    ).toBe("http://localhost:3000/app/subscribers/sub_456");
  });

  it("returns null for unknown entities or unsafe ids", () => {
    expect(entityShareUrl("not-an-entity", "abc")).toBeNull();
    // unsafe ids (path traversal / extra segment) are rejected by route-map
    expect(entityShareUrl("campaign", "../escape")).toBeNull();
    expect(entityShareUrl("campaign", "")).toBeNull();
  });
});
