/**
 * Tests for the mobile half of the cross-device resume cursor
 * (GET/PUT /api/v1/activity/last-viewed, apps/api/internal/activitycursor).
 *
 * Mobile resolves destinations through `mobilePath`, so a cursor pointing at an
 * entity the app has no screen for (an affiliate — there is no Affiliates tab)
 * is treated as absent rather than rendered as a card that goes nowhere.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createActivityCursorClient,
  resumeRoute,
  resumeTypeLabel,
} from "./activityCursor";

function ok<T>(data: T) {
  return vi.fn().mockResolvedValue({ data, error: null });
}
function fail(status: number, code = "err") {
  return vi
    .fn()
    .mockResolvedValue({ data: null, error: { message: "no", status, code } });
}

const CURSOR = {
  entity_key: "campaign",
  entity_id: "cam_1",
  viewed_at: "2026-08-04T09:00:00Z",
};

describe("recordLastViewed", () => {
  it("PUTs a reference the registry accepts", async () => {
    const request = ok(null);
    await createActivityCursorClient({ request }).recordLastViewed(
      "campaign",
      "cam_1",
    );
    expect(request).toHaveBeenCalledTimes(1);
    const [method, path, body] = request.mock.calls[0]!;
    expect(method).toBe("PUT");
    expect(path).toBe("/api/v1/activity/last-viewed");
    expect(body).toEqual({ entity_key: "campaign", entity_id: "cam_1" });
  });

  it("drops a reference route-map would reject before any request", async () => {
    const request = ok(null);
    const client = createActivityCursorClient({ request });
    await client.recordLastViewed("nope", "x1");
    await client.recordLastViewed("campaign", "has/slash");
    expect(request).not.toHaveBeenCalled();
  });

  it("never rejects — a failed continuity write must not break a screen", async () => {
    const thrown = createActivityCursorClient({
      request: vi.fn().mockRejectedValue(new Error("airplane mode")),
    });
    await expect(
      thrown.recordLastViewed("campaign", "cam_1"),
    ).resolves.toBeUndefined();
    const request = fail(503);
    const onUnexpectedError = vi.fn();
    const errored = createActivityCursorClient({ request, onUnexpectedError });
    await expect(
      errored.recordLastViewed("campaign", "cam_1"),
    ).resolves.toBeUndefined();
    // The write was attempted, and a failed best-effort write is not a read
    // fault — firing the read telemetry here would drown the real signal.
    expect(request).toHaveBeenCalledTimes(1);
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  it("does not report an auth mode the route legitimately refuses", async () => {
    const onUnexpectedError = vi.fn();
    for (const [status, code] of [
      [403, "insufficient_auth_method"],
      [0, "offline"],
    ] as const) {
      const client = createActivityCursorClient({
        request: fail(status, code),
        onUnexpectedError,
      });
      await expect(client.fetchLastViewed()).resolves.toBeNull();
    }
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });
});

describe("fetchLastViewed", () => {
  it("returns a cursor mobile can open", async () => {
    const client = createActivityCursorClient({ request: ok(CURSOR) });
    await expect(client.fetchLastViewed()).resolves.toEqual(CURSOR);
  });

  it("returns null for 204 / empty body", async () => {
    const client = createActivityCursorClient({ request: ok(null) });
    await expect(client.fetchLastViewed()).resolves.toBeNull();
  });

  it("stays silent for signed-out and no-cursor", async () => {
    const onUnexpectedError = vi.fn();
    for (const status of [401, 404]) {
      const client = createActivityCursorClient({
        request: fail(status),
        onUnexpectedError,
      });
      await expect(client.fetchLastViewed()).resolves.toBeNull();
    }
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected failure rather than calling it 'no cursor'", async () => {
    const onUnexpectedError = vi.fn();
    const client = createActivityCursorClient({
      request: fail(500, "boom"),
      onUnexpectedError,
    });
    await expect(client.fetchLastViewed()).resolves.toBeNull();
    expect(onUnexpectedError).toHaveBeenCalledWith({
      status: 500,
      code: "boom",
    });
  });

  it("drops a cursor for an entity this app has no screen for", async () => {
    // Affiliates: web-routable, no mobile tab. `mobilePath` returns null, so the
    // resume card must not appear rather than deep-link into nothing.
    const client = createActivityCursorClient({
      request: ok({ ...CURSOR, entity_key: "affiliate", entity_id: "af_1" }),
    });
    await expect(client.fetchLastViewed()).resolves.toBeNull();
  });
});

describe("resumeRoute / resumeTypeLabel", () => {
  it("resolves through mobilePath, including the list fallback", () => {
    expect(resumeRoute(CURSOR)).toBe("/(tabs)/campaigns/cam_1");
    // `template` has no mobile detail screen, so the cursor lands on the list —
    // the closest reachable destination, not a dead route.
    expect(
      resumeRoute({ ...CURSOR, entity_key: "template", entity_id: "tpl_1" }),
    ).toBe("/(tabs)/templates");
  });

  it("returns null when mobile does not ship the entity", () => {
    expect(
      resumeRoute({ ...CURSOR, entity_key: "affiliate", entity_id: "af_1" }),
    ).toBeNull();
    expect(
      resumeRoute({
        ...CURSOR,
        entity_key: "helpdesk-ticket",
        entity_id: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBeNull();
  });

  it("labels the entity TYPE only — the cursor holds no content", () => {
    expect(resumeTypeLabel(CURSOR)).toBe("Campaign");
    expect(
      resumeTypeLabel({ ...CURSOR, entity_key: "helpdesk-conversation" }),
    ).toBe("Helpdesk conversation");
  });
});
