// SPDX-License-Identifier: AGPL-3.0-only
//
// /podcasts publishes the private-feed contract in unusual detail: the token's
// entropy and encoding, the exact URL shape, the exact Cache-Control header,
// the iTunes tag that keeps a personal feed out of directories, and the literal
// 401 body a revoked token returns. Every one matched the Go implementation.
//
// They are pinned because each is something a reader builds against. A podcast
// client author who trusts "path segment, not query string" and finds the token
// moved to a query has a broken integration; an operator who trusts
// "private, no-store" and finds a shared CDN caching one subscriber's feed has
// a disclosure incident.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const PAGE = readFileSync(
  join(SRC, "app/(marketing)/podcasts/page.tsx"),
  "utf8",
);
const GO = readFileSync(
  join(REPO, "apps/api/internal/podcast/podcast.go"),
  "utf8",
);

describe("/podcasts published claims", () => {
  it("reads both sides", () => {
    // Guard the guard: an empty read makes every containment check pass.
    expect(PAGE.length).toBeGreaterThan(4_000);
    expect(GO).toMatch(/func MintTokenSecret/);
  });

  it("states the real token entropy and encoding", () => {
    const bytes = /func MintTokenSecret[\s\S]*?var buf \[(\d+)\]byte/.exec(GO);
    expect(bytes).not.toBeNull();
    expect(PAGE).toContain(`${Number(bytes![1]) * 8}-bit`);
    expect(GO).toMatch(/base64\.RawURLEncoding/);
    expect(PAGE).toMatch(/base64url/);
  });

  it("keeps the token in the path, not a query string", () => {
    // The stated reason is that CDNs and directories strip query strings.
    expect(GO).toMatch(/feed\/\{token\}\.xml/);
    expect(PAGE).toContain("/feed/{token}.xml");
    expect(PAGE).toMatch(/path segment, not a query string/);
  });

  it("quotes the Cache-Control header the handler actually sets", () => {
    const header =
      /w\.Header\(\)\.Set\("Cache-Control", "([^"]+)"\)/.exec(GO)?.[1] ?? "";
    expect(header).not.toBe("");
    expect(PAGE).toContain(header);
  });

  it("names the iTunes tag that hides a personal feed", () => {
    expect(GO).toMatch(/<itunes:block>yes<\/itunes:block>/);
    expect(PAGE).toMatch(/itunes:block/);
  });

  it("quotes the revoked-token response verbatim", () => {
    // Both the status and the body string — a client may branch on either.
    const body = /http\.Error\(w, "(feed revoked)", http\.Status(\w+)\)/.exec(
      GO,
    );
    expect(body).not.toBeNull();
    expect(body![2]).toBe("Unauthorized");
    expect(PAGE).toContain(`401 '${body![1]}'`);
  });

  it("describes revocation as preserving the row", () => {
    // "revoked" rather than "never minted" is the whole point of keeping the
    // row with revoked_at set.
    expect(GO).toMatch(/revoked_at set/);
    expect(PAGE).toMatch(/revoked_at/);
    expect(PAGE).toMatch(/never/);
  });
});
