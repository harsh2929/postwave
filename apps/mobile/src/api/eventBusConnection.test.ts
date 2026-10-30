import { describe, expect, it } from "vitest";

import {
  eventBusBearer,
  eventBusRequestPath,
  eventBusStreamUrl,
  eventBusTenantSlug,
  MAX_PRESENCE_ENTITY_REF_LENGTH,
  normalizePresenceEntityRef,
} from "./eventBusConnection";

/**
 * The realtime transport's connection rules — the half of `eventBus.ts` that
 * decides WHO connects and WHERE, extracted so it can be tested at all.
 *
 * Everything asserted here fails silently in production if it regresses: a
 * wrong tenant header, a bearer missing its prefix or a malformed URL all
 * present as "the live feed is quiet", which is indistinguishable from "there
 * was no activity". That is precisely why it needs a test rather than a
 * watchful reviewer.
 */

const SESSION = {
  apiKey: null,
  mode: "session",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceSlug: "acme",
};

describe("eventBusTenantSlug", () => {
  it("sends a session's workspace SLUG, never its tenant UUID", () => {
    // The header is X-Tenant-Slug. Sending the UUID here is a real, shipped
    // class of bug: it looks plausible, resolves to no workspace, and the
    // stream simply never delivers.
    expect(eventBusTenantSlug(SESSION)).toBe("acme");
  });

  it("falls back to the stored tenant only in api-key mode", () => {
    // In api-key mode the stored value IS the slug the user typed.
    expect(
      eventBusTenantSlug({
        apiKey: "pw_k",
        mode: "api_key",
        tenantId: "acme",
        workspaceSlug: null,
      }),
    ).toBe("acme");
  });

  it("sends nothing rather than guessing when the mode is unknown", () => {
    expect(
      eventBusTenantSlug({
        apiKey: null,
        mode: null,
        tenantId: "acme",
        workspaceSlug: null,
      }),
    ).toBeNull();
    // A session mid-restore has a tenant id and no slug yet. Sending the id
    // would be a wrong header; sending none lets the server answer honestly.
    expect(eventBusTenantSlug({ ...SESSION, workspaceSlug: null })).toBeNull();
    expect(
      eventBusTenantSlug({ ...SESSION, workspaceSlug: undefined }),
    ).toBeNull();
  });
});

describe("eventBusBearer", () => {
  it("adds the pw_ prefix to a key pasted without it", () => {
    expect(eventBusBearer("abc123")).toBe("pw_abc123");
  });

  it("leaves an already-prefixed key untouched, never doubling it", () => {
    expect(eventBusBearer("pw_abc123")).toBe("pw_abc123");
  });

  it("is null in session mode, where the cookie carries the identity", () => {
    expect(eventBusBearer(null)).toBeNull();
    expect(eventBusBearer("")).toBeNull();
  });
});

describe("eventBusRequestPath", () => {
  it("encodes the topic CSV so a comma cannot split the query", () => {
    const path = eventBusRequestPath(["campaign.created", "subscriber.added"]);
    expect(path).toBe(
      "/api/v1/events?topics=campaign.created%2Csubscriber.added",
    );
    expect(path).not.toContain("topics=campaign.created,");
  });

  it("normalises the topic list rather than trusting the caller", () => {
    // Duplicates and blanks come from composed hooks subscribing to overlapping
    // sets; the server counts topics against a cap.
    const path = eventBusRequestPath([
      "campaign.created",
      "campaign.created",
      "  ",
    ]);
    expect(path).toBe("/api/v1/events?topics=campaign.created");
  });

  // Per-record presence (SHELL-036). The server reads `?entity=` off the
  // subscription itself — there is no separate "join" call — so this query
  // parameter IS the membership registration.
  it("omits entity entirely when no record scope is asked for", () => {
    const path = eventBusRequestPath(["campaign.created"]);
    expect(path).not.toContain("entity=");
    expect(eventBusRequestPath(["campaign.created"], "  ")).not.toContain(
      "entity=",
    );
  });

  it("appends an encoded entity ref so a colon cannot break the query", () => {
    const path = eventBusRequestPath(["presence.entity"], "campaign:a b&c");
    expect(path).toBe(
      "/api/v1/events?topics=presence.entity&entity=campaign%3Aa%20b%26c",
    );
  });

  it("truncates to the server's bound so both sides key the same room", () => {
    // apps/api/internal/events/handler.go trims at 128. Sending more would put
    // us in a room named by the server's truncation while we filter payloads
    // against the untruncated ref — presence would appear permanently empty.
    const ref = `campaign:${"x".repeat(300)}`;
    const path = eventBusRequestPath(["presence.entity"], ref);
    const sent = decodeURIComponent(path.split("entity=")[1] ?? "");
    expect(sent).toHaveLength(MAX_PRESENCE_ENTITY_REF_LENGTH);
    expect(ref.startsWith(sent)).toBe(true);
  });
});

describe("normalizePresenceEntityRef", () => {
  it("is null for nothing", () => {
    expect(normalizePresenceEntityRef(null)).toBeNull();
    expect(normalizePresenceEntityRef(undefined)).toBeNull();
    expect(normalizePresenceEntityRef("   ")).toBeNull();
  });

  it("trims but otherwise preserves the ref", () => {
    expect(normalizePresenceEntityRef("  campaign:abc  ")).toBe("campaign:abc");
  });
});

describe("eventBusStreamUrl", () => {
  const path = "/api/v1/events?topics=campaign.created";

  it("returns the bare path when no base URL is configured", () => {
    // Not a half-formed absolute URL: the caller's "not connected" branch has
    // to stay reachable while the app is still being pointed at a host.
    expect(eventBusStreamUrl({ baseUrl: null, path, streamToken: null })).toBe(
      path,
    );
    expect(eventBusStreamUrl({ baseUrl: "", path, streamToken: null })).toBe(
      path,
    );
  });

  it("carries the stream token as a query parameter", () => {
    // An EventSource-shaped GET cannot carry an Authorization header, which is
    // the entire reason POST /api/v1/streams/token exists.
    const url = eventBusStreamUrl({
      baseUrl: "https://api.example.com",
      path,
      streamToken: "tok 1",
    });
    expect(url).toContain("topics=campaign.created");
    expect(url).toContain("stream_token=tok+1");
  });

  it("omits the parameter entirely when no token was minted", () => {
    // Rather than `stream_token=` or `=null`, either of which the server has
    // to interpret as a credential attempt.
    const url = eventBusStreamUrl({
      baseUrl: "https://api.example.com",
      path,
      streamToken: null,
    });
    expect(url).toBe("https://api.example.com/api/v1/events?topics=campaign.created");
  });

  it("refuses a base URL that is not a safe API host", () => {
    // `apiUrl` is the shared guard (no credentials, no plain http off
    // localhost). The stream must not be the one caller that bypasses it.
    expect(() =>
      eventBusStreamUrl({
        baseUrl: "http://evil.example.com",
        path,
        streamToken: null,
      }),
    ).toThrow();
  });
});
