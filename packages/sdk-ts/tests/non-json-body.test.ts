/**
 * A JSON method must never hand back a non-JSON body as if it were the
 * declared type.
 *
 * WHAT THIS PREVENTS, observed in-app on 2026-08-19. A reverse proxy answered
 * `GET /api/v1/migrations` with **200 text/html** — an SPA fallback served
 * because the migrations upstream was absent. The client returned that HTML
 * STRING typed as `MigrationJob[]`, and the mobile screen did what any caller
 * would: read `.length` (1,293 — the document's character count) and mapped
 * over it. The result was 1,293 phantom jobs, one per character, every `id`
 * undefined, every React key identical, and a red-screen from the first
 * `job.id.slice()`.
 *
 * A 200 carrying the wrong media type is a protocol failure. It has to be
 * louder than a value, because a value gets rendered.
 */
import { describe, expect, it, vi } from "vitest";

import { ParseError, PostwaveClient } from "../src/index.js";

function clientReturning(body: string, contentType: string) {
  const fetch = vi.fn(
    async () =>
      new Response(body, { status: 200, headers: { "content-type": contentType } }),
  );
  return new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
}

const HTML = "<!DOCTYPE html><html><head><title>Moosewave</title></head></html>";

describe("a non-JSON 200 body", () => {
  it("throws instead of being returned as the declared type", async () => {
    const pw = clientReturning(HTML, "text/html");
    await expect(pw.request("GET", "/api/v1/migrations")).rejects.toBeInstanceOf(
      ParseError,
    );
  });

  it("never yields something a caller could map over", async () => {
    // The precise failure: `.length` on an HTML string is a plausible-looking
    // row count, so the caller renders one row per character.
    const pw = clientReturning(HTML, "text/html");
    let out: unknown = "unset";
    try {
      out = await pw.request("GET", "/api/v1/migrations");
    } catch {
      out = "threw";
    }
    expect(out).toBe("threw");
  });

  it("still returns text when the caller ASKED for text", async () => {
    // export.csv and friends are legitimately not JSON.
    const pw = clientReturning("a,b\n1,2\n", "text/csv");
    await expect(
      pw.request("GET", "/api/v1/subscribers/export.csv", { asText: true }),
    ).resolves.toContain("a,b");
  });

  it("still parses a normal JSON body", async () => {
    const pw = clientReturning('{"ok":true}', "application/json");
    await expect(pw.request("GET", "/api/v1/me")).resolves.toEqual({ ok: true });
  });
});
