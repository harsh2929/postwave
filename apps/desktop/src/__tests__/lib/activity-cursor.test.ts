// Tests for the desktop half of the cross-device "resume where you left off"
// cursor (GET/PUT /api/v1/activity/last-viewed, apps/api/internal/activitycursor).
//
// The server has shipped this endpoint since the Apple-level integration Phase-1
// work, and apps/web has consumed it since. Desktop and mobile never did — the
// continuity feature existed on exactly one of the three clients, which is the
// opposite of what a cross-DEVICE cursor is for.
//
// Desktop resolves the destination through `desktopPath`, NOT `webPath`: the two
// surfaces own different section vocabularies, so a cursor pointing at an entity
// desktop cannot route (a flow, a landing page) must be treated as absent rather
// than rendered as a dead card.

import { describe, expect, it, vi } from "vitest";

import {
  createActivityCursorClient,
  resumeHref,
  resumeTypeLabel,
} from "../../lib/activity-cursor";

/** Minimal stand-in for the desktop `apiRequest` result union. */
function okResponse<T>(data: T) {
  return vi.fn().mockResolvedValue({ data });
}
function errResponse(status: number, code = "err") {
  return vi.fn().mockResolvedValue({ error: { message: "no", status, code } });
}

const CURSOR = {
  entity_key: "campaign",
  entity_id: "cam_1",
  viewed_at: "2026-08-04T09:00:00Z",
};

describe("recordLastViewed", () => {
  it("PUTs the reference for an entity the registry knows", async () => {
    const request = okResponse(undefined);
    const client = createActivityCursorClient({ request });
    await client.recordLastViewed("campaign", "cam_1");
    expect(request).toHaveBeenCalledTimes(1);
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/api/v1/activity/last-viewed");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      entity_key: "campaign",
      entity_id: "cam_1",
    });
  });

  it("never sends a reference route-map would reject", async () => {
    // Client-side validation with the SAME predicate that mints links, so a bad
    // id is dropped here instead of round-tripping to a 400.
    const request = okResponse(undefined);
    const client = createActivityCursorClient({ request });
    await client.recordLastViewed("not-an-entity", "x1");
    await client.recordLastViewed("campaign", "has/slash");
    await client.recordLastViewed("campaign", "");
    await client.recordLastViewed("helpdesk-ticket", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await client.recordLastViewed("helpdesk-conversation", "ticket_123");
    expect(request).not.toHaveBeenCalled();
  });

  it("swallows transport failures — continuity must never disrupt the page", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    const client = createActivityCursorClient({ request });
    await expect(
      client.recordLastViewed("campaign", "cam_1"),
    ).resolves.toBeUndefined();
  });

  it("swallows an error RESULT without reporting it as a read fault", async () => {
    // Desktop's client returns `{error}` rather than throwing. A write failure
    // must still resolve void, AND must not fire the read-failure telemetry —
    // that signal exists to tell a broken FETCH from an empty resume card, and
    // a failed best-effort write is neither.
    const request = errResponse(500);
    const onUnexpectedError = vi.fn();
    const client = createActivityCursorClient({ request, onUnexpectedError });
    await expect(
      client.recordLastViewed("campaign", "cam_1"),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  it("does not report an auth mode the route legitimately refuses", async () => {
    // The endpoint is session-only; both native clients also support API-key
    // auth, where it answers 403. Reporting that would fire on every dashboard
    // mount in that mode and drown the signal.
    const onUnexpectedError = vi.fn();
    for (const [status, code] of [
      [403, "insufficient_auth_method"],
      [0, "offline"],
      [0, "identity_transition"],
    ] as const) {
      const client = createActivityCursorClient({
        request: errResponse(status, code),
        onUnexpectedError,
      });
      await expect(client.fetchLastViewed()).resolves.toBeNull();
    }
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });
});

describe("fetchLastViewed", () => {
  it("returns a cursor that still resolves on this surface", async () => {
    const client = createActivityCursorClient({ request: okResponse(CURSOR) });
    await expect(client.fetchLastViewed()).resolves.toEqual(CURSOR);
  });

  it("treats 204 / empty as no cursor", async () => {
    const client = createActivityCursorClient({
      request: okResponse(undefined),
    });
    await expect(client.fetchLastViewed()).resolves.toBeNull();
  });

  it("treats signed-out and not-found as absence, silently", async () => {
    const onUnexpected = vi.fn();
    for (const status of [401, 404]) {
      const client = createActivityCursorClient({
        request: errResponse(status),
        onUnexpectedError: onUnexpected,
      });
      await expect(client.fetchLastViewed()).resolves.toBeNull();
    }
    expect(onUnexpected).not.toHaveBeenCalled();
  });

  it("reports an unexpected failure instead of masking it as 'no cursor'", async () => {
    // A 403 or 5xx is a REAL problem. Returning null keeps continuity
    // best-effort, but the failure must still be observable.
    const onUnexpectedError = vi.fn();
    const client = createActivityCursorClient({
      request: errResponse(500, "boom"),
      onUnexpectedError,
    });
    await expect(client.fetchLastViewed()).resolves.toBeNull();
    expect(onUnexpectedError).toHaveBeenCalledWith({
      status: 500,
      code: "boom",
    });
  });

  it("drops a cursor this surface cannot route", async () => {
    // A flow recorded from the web dashboard: desktop's section vocabulary has
    // `automations`, not `flows`, so `desktopPath` returns null. Rendering the
    // card anyway would offer a button that goes nowhere.
    const client = createActivityCursorClient({
      request: okResponse({ ...CURSOR, entity_key: "flow", entity_id: "fl_1" }),
    });
    await expect(client.fetchLastViewed()).resolves.toBeNull();
  });

  it("drops a malformed or unknown-entity cursor", async () => {
    for (const bad of [
      { entity_key: "", entity_id: "x", viewed_at: "" },
      { entity_key: "campaign", entity_id: "", viewed_at: "" },
      { entity_key: "sombrero", entity_id: "x", viewed_at: "" },
      { entity_key: "campaign", entity_id: "has/slash", viewed_at: "" },
    ]) {
      const client = createActivityCursorClient({ request: okResponse(bad) });
      await expect(client.fetchLastViewed()).resolves.toBeNull();
    }
  });
});

describe("resumeHref / resumeTypeLabel", () => {
  it("resolves through desktopPath, not webPath", () => {
    // `list` is web-"none" but desktop-routable — proving the desktop card uses
    // its OWN surface axis. If this used webPath it would return null and the
    // card would never appear for an entity desktop can open.
    expect(
      resumeHref({ ...CURSOR, entity_key: "list", entity_id: "l_1" }),
    ).toBe("/app/lists/l_1");
    expect(resumeHref(CURSOR)).toBe("/app/campaigns/cam_1");
    expect(
      resumeHref({
        ...CURSOR,
        entity_key: "helpdesk-conversation",
        entity_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toBe("/app/helpdesk/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("returns null for an entity desktop cannot route", () => {
    expect(
      resumeHref({ ...CURSOR, entity_key: "flow", entity_id: "fl_1" }),
    ).toBeNull();
    expect(
      resumeHref({
        ...CURSOR,
        entity_key: "helpdesk-ticket",
        entity_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toBeNull();
    expect(
      resumeHref({
        ...CURSOR,
        entity_key: "helpdesk-conversation",
        entity_id: "ticket_123",
      }),
    ).toBeNull();
  });

  it("labels the entity TYPE, never entity content", () => {
    // The cursor stores an id reference only — there is no title to show, and
    // inventing one would imply the server keeps content it deliberately does not.
    expect(resumeTypeLabel(CURSOR)).toBe("Campaign");
    expect(
      resumeTypeLabel({ ...CURSOR, entity_key: "helpdesk-conversation" }),
    ).toBe("Helpdesk conversation");
    expect(resumeTypeLabel({ ...CURSOR, entity_key: "unknown" })).toBe(
      "Unknown",
    );
  });
});
