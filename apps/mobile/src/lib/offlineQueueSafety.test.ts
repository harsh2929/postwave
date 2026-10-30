import { describe, expect, it } from "vitest";

import {
  isOnlineOnlyRoute,
  isQueueableMutation,
  isSafeQueueBody,
  normalizeQueuePath,
  offlineQueueSafetyPolicy,
} from "./offlineQueueSafety";

describe("normalizeQueuePath", () => {
  it("keeps a plain API path", () => {
    expect(normalizeQueuePath("/api/v1/tags/7")).toBe("/api/v1/tags/7");
  });

  it("strips query and fragment", () => {
    expect(normalizeQueuePath("/api/v1/tags/7?x=1#frag")).toBe("/api/v1/tags/7");
  });

  it("rejects an absolute URL outright — a queued write is always baseUrl-relative", () => {
    expect(normalizeQueuePath("https://api.moosewave.com/api/v1/tags")).toBeNull();
    expect(normalizeQueuePath("https://evil.example/api/v1/tags/1")).toBeNull();
    expect(normalizeQueuePath("//evil.example/api/v1/tags")).toBeNull();
    expect(normalizeQueuePath("javascript:alert(1)")).toBeNull();
  });

  it("rejects a non-API path", () => {
    expect(normalizeQueuePath("/internal/admin")).toBeNull();
    expect(normalizeQueuePath("")).toBeNull();
  });

  it("rejects traversal and doubled separators", () => {
    expect(normalizeQueuePath("/api/v1/tags/../../billing")).toBeNull();
    expect(normalizeQueuePath("/api//v1/tags")).toBeNull();
  });

  it("rejects an oversized path", () => {
    expect(
      normalizeQueuePath(`/api/v1/tags/${"a".repeat(600)}`),
    ).toBeNull();
  });
});

describe("isQueueableMutation — verbs", () => {
  it("queues POST/PATCH/PUT only", () => {
    expect(isQueueableMutation("POST", "/api/v1/tags")).toBe(true);
    expect(isQueueableMutation("patch", "/api/v1/segments/1")).toBe(true);
    expect(isQueueableMutation("GET", "/api/v1/tags")).toBe(false);
    expect(isQueueableMutation("DELETE", "/api/v1/tags/1")).toBe(false);
  });
});

describe("isQueueableMutation — the route table", () => {
  const queueable: readonly (readonly [string, string])[] = [
    ["POST", "/api/v1/forms"],
    ["PATCH", "/api/v1/forms/abc"],
    ["POST", "/api/v1/segments"],
    ["PATCH", "/api/v1/segments/abc"],
    ["POST", "/api/v1/lists"],
    ["PATCH", "/api/v1/lists/12"],
    ["POST", "/api/v1/tags"],
    ["PATCH", "/api/v1/campaigns/abc"],
    ["POST", "/api/v1/voice/labels"],
    ["POST", "/api/v1/lists/12/subscribers"],
  ];

  it("covers every allowlisted shape", () => {
    for (const [method, path] of queueable) {
      expect(`${method} ${path}`, `${method} ${path}`).toBe(`${method} ${path}`);
      expect(isQueueableMutation(method, path, {})).toBe(true);
    }
    // The table is the contract — a silent shrink is a regression.
    expect(offlineQueueSafetyPolicy.safeRouteCount).toBe(queueable.length);
  });

  it("queues an add-to-list but never a remove-from-list (AUDIENCE#33)", () => {
    // lists.AddSubscribers only ever ADDS and the route is idempotent by
    // construction, so a late replay cannot destroy a membership.
    expect(
      isQueueableMutation("POST", "/api/v1/lists/12/subscribers", {
        subscriber_ids: ["11111111-2222-3333-4444-555555555555"],
      }),
    ).toBe(true);
    // Its sibling DELETE is unrecoverable if it lands an hour late.
    expect(
      isQueueableMutation("DELETE", "/api/v1/lists/12/subscribers/abc"),
    ).toBe(false);
    // And the nested membership path is not a wildcard into other sub-routes.
    expect(
      isQueueableMutation("POST", "/api/v1/lists/12/subscribers/abc"),
    ).toBe(false);
  });

  it("refuses routes outside the table", () => {
    expect(isQueueableMutation("POST", "/api/v1/webhooks")).toBe(false);
    expect(isQueueableMutation("PATCH", "/api/v1/settings/sending")).toBe(false);
    // Nested subscriber sub-resources are denied even though the parent is not.
    expect(isQueueableMutation("POST", "/api/v1/subscribers/abc/notes")).toBe(
      false,
    );
  });
});

describe("isQueueableMutation — online-only denylist beats the allowlist", () => {
  it("never queues sends or scheduling", () => {
    expect(isQueueableMutation("POST", "/api/v1/campaigns/abc/send")).toBe(
      false,
    );
    expect(isQueueableMutation("POST", "/api/v1/campaigns/abc/test-send")).toBe(
      false,
    );
    expect(isQueueableMutation("POST", "/api/v1/campaigns/abc/schedule")).toBe(
      false,
    );
  });

  it("never queues a versioned draft checkpoint (ECO-03)", () => {
    // A checkpoint PUT carries the version it was built on and the server
    // refuses it with 409 the moment that is not the current one. Replayed an
    // hour later it is a guaranteed conflict with no editor open to resolve
    // it — and if the version happened to still match, it would overwrite the
    // newer draft written from whichever device the person moved to.
    const path = "/api/v1/editor/checkpoints/campaign/cmp_1";
    for (const method of ["PUT", "POST", "PATCH", "DELETE"]) {
      expect(
        isQueueableMutation(method, path, {
          content: { subject: "half a thought" },
          version: 3,
        }),
        method,
      ).toBe(false);
      // Asserted through the DENYLIST as well, not only through the combined
      // answer. The route is not on the allowlist either, so the combined
      // answer alone would be false whether the deliberate refusal existed or
      // not — and a later allowlist growth could then make a versioned write
      // queueable with every test still green.
      expect(isOnlineOnlyRoute(method, path), method).toBe(true);
    }
  });

  it("never queues a PATCH the server answers 428 without a strong If-Match", () => {
    // Both handlers refuse an unconditional write with 428 before touching
    // anything, and a queued record carries no precondition, so a replay can
    // only ever be refused. Asserted through the DENYLIST too: dropping the
    // allowlist rows alone would leave nothing stopping a later table growth
    // from quietly re-admitting them.
    for (const path of ["/api/v1/subscribers/abc", "/api/v1/tags/12"]) {
      expect(isQueueableMutation("PATCH", path, { name: "Ada" }), path).toBe(false);
      expect(isOnlineOnlyRoute("PATCH", path), path).toBe(true);
      expect(isOnlineOnlyRoute("PUT", path), path).toBe(true);
    }
    // Creating a tag needs no token and stays queueable.
    expect(isQueueableMutation("POST", "/api/v1/tags", { name: "VIP" })).toBe(true);
    expect(isOnlineOnlyRoute("POST", "/api/v1/tags")).toBe(false);
  });

  it("never queues billing, auth, keys, privacy or migrations", () => {
    for (const path of [
      "/api/v1/billing/subscription",
      "/api/v1/auth/password",
      "/api/v1/api-keys",
      "/api/v1/privacy/export",
      "/api/v1/settings/privacy",
      "/api/v1/settings/email-compliance",
      "/api/v1/migrations/start",
    ]) {
      expect(isQueueableMutation("POST", path, {}), path).toBe(false);
    }
  });

  it("never queues bulk/merge/identify or imports", () => {
    for (const path of [
      "/api/v1/subscribers/bulk",
      "/api/v1/subscribers/merge",
      // AUDIENCE#57: the scan-bound merge the duplicates queue uses. It
      // consolidates two people's consent records and re-points their
      // history; a late replay could only ever land a plan the server has
      // already invalidated.
      "/api/v1/merge/apply",
      "/api/v1/subscribers/identify",
      "/api/v1/subscriber-imports",
    ]) {
      expect(isQueueableMutation("POST", path, {}), path).toBe(false);
    }
  });
});

describe("isSafeQueueBody", () => {
  it("blocks a campaign PATCH that schedules or starts a send", () => {
    const path = "/api/v1/campaigns/abc";
    expect(isSafeQueueBody("PATCH", path, { subject: "Hi" })).toBe(true);
    expect(isSafeQueueBody("PATCH", path, { status: "scheduled" })).toBe(false);
    expect(isSafeQueueBody("PATCH", path, { status: "sending" })).toBe(false);
    expect(isSafeQueueBody("PATCH", path, { status: "sent" })).toBe(false);
    expect(
      isSafeQueueBody("PATCH", path, { scheduled_at: "2026-01-01T00:00:00Z" }),
    ).toBe(false);
    // Draft status is still an edit, not a send.
    expect(isSafeQueueBody("PATCH", path, { status: "draft" })).toBe(true);
  });

  it("blocks publishing a form but allows a draft edit", () => {
    const path = "/api/v1/forms/abc";
    expect(isSafeQueueBody("PATCH", path, { name: "Signup" })).toBe(true);
    expect(isSafeQueueBody("PATCH", path, { status: "published" })).toBe(false);
  });

  it("blocks every subscriber consent/delivery key", () => {
    const path = "/api/v1/subscribers/abc";
    expect(isSafeQueueBody("PATCH", path, { name: "Ada" })).toBe(true);
    for (const key of offlineQueueSafetyPolicy.subscriberOnlineOnlyKeys) {
      expect(isSafeQueueBody("PATCH", path, { [key]: "x" }), key).toBe(false);
    }
  });

  it("treats a non-object or array body as unqueueable for PATCH arrays", () => {
    expect(isSafeQueueBody("PATCH", "/api/v1/tags/1", [1, 2])).toBe(false);
    expect(isSafeQueueBody("POST", "/api/v1/tags", [1, 2])).toBe(true);
  });

  it("is enforced through isQueueableMutation, not just standalone", () => {
    expect(
      isQueueableMutation("PATCH", "/api/v1/subscribers/abc", {
        status: "unsubscribed",
      }),
    ).toBe(false);
    // The whole subscriber route is online-only now (it needs If-Match), so
    // even a harmless profile edit is refused.
    expect(
      isQueueableMutation("PATCH", "/api/v1/subscribers/abc", { name: "Ada" }),
    ).toBe(false);
    // The positive control for the body carve-out: a queueable route whose
    // body alone decides.
    expect(
      isQueueableMutation("PATCH", "/api/v1/forms/abc", { status: "published" }),
    ).toBe(false);
    expect(
      isQueueableMutation("PATCH", "/api/v1/forms/abc", { name: "Signup" }),
    ).toBe(true);
  });
});
