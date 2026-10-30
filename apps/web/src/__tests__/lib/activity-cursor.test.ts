// SPDX-License-Identifier: AGPL-3.0-only
//
// Cross-device "resume where you left off" client (lib/activity-cursor). The
// recorder must drop references route-map rejects before they reach the wire,
// and the reader must degrade to "no cursor" on every failure mode (204,
// signed-out 401, or a reference this build no longer maps) so the dashboard
// simply omits the resume card rather than rendering a dead link or throwing.

import { describe, it, expect, vi, beforeEach } from "vitest";

const put = vi.fn();
const get = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    put: (...args: unknown[]) => put(...args),
    get: (...args: unknown[]) => get(...args),
  },
  isApiError: () => true,
}));

import {
  recordLastViewed,
  fetchLastViewed,
  resumeHref,
  resumeTypeLabel,
} from "@/lib/activity-cursor";

beforeEach(() => {
  put.mockReset();
  get.mockReset();
});

describe("recordLastViewed", () => {
  it("sends a valid (entity, id) reference", async () => {
    put.mockResolvedValue(undefined);
    await recordLastViewed("campaign", "cmp_123");
    expect(put).toHaveBeenCalledWith("/api/v1/activity/last-viewed", {
      entity_key: "campaign",
      entity_id: "cmp_123",
    });
  });

  it("drops an unknown entity before the wire", async () => {
    await recordLastViewed("not-an-entity", "cmp_123");
    expect(put).not.toHaveBeenCalled();
  });

  it("drops an unsafe id before the wire", async () => {
    await recordLastViewed("campaign", "../escape");
    expect(put).not.toHaveBeenCalled();
  });

  it("never throws when the write fails", async () => {
    put.mockRejectedValue(new Error("boom"));
    await expect(recordLastViewed("campaign", "cmp_123")).resolves.toBeUndefined();
  });
});

describe("fetchLastViewed", () => {
  it("returns a resolvable cursor", async () => {
    get.mockResolvedValue({
      entity_key: "campaign",
      entity_id: "cmp_123",
      viewed_at: "2026-07-20T00:00:00Z",
    });
    expect(await fetchLastViewed()).toEqual({
      entity_key: "campaign",
      entity_id: "cmp_123",
      viewed_at: "2026-07-20T00:00:00Z",
    });
  });

  it("returns null for a 204 (undefined body)", async () => {
    get.mockResolvedValue(undefined);
    expect(await fetchLastViewed()).toBeNull();
  });

  it("returns null when the cursor no longer maps to a route", async () => {
    get.mockResolvedValue({
      entity_key: "obsolete_entity",
      entity_id: "x1",
      viewed_at: "2026-07-20T00:00:00Z",
    });
    expect(await fetchLastViewed()).toBeNull();
  });

  it("returns null when the reader is signed out (throws)", async () => {
    get.mockRejectedValue(new Error("401"));
    expect(await fetchLastViewed()).toBeNull();
  });
});

describe("resume helpers", () => {
  const cursor = {
    entity_key: "subscriber",
    entity_id: "sub_9",
    viewed_at: "2026-07-20T00:00:00Z",
  };
  it("resolves the in-app route via route-map", () => {
    expect(resumeHref(cursor)).toBe("/app/subscribers/sub_9");
  });
  it("names the entity type, capitalised", () => {
    expect(resumeTypeLabel(cursor)).toBe("Subscriber");
  });
});
