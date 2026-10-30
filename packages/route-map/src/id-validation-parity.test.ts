// SPDX-License-Identifier: AGPL-3.0-only
//
// entities.ts says isSafeResourceId "mirrors desktop's `is_safe_resource_id`".
// No function by that name exists in the Rust. What exists is a PAIR, and the
// difference between them is a real cross-surface behaviour gap:
//
//   is_resource_id(v)        alphanumeric + `-` `_`, ≤128 bytes
//   is_subscriber_target(v)  alphanumeric + `.` `_` `+` `@` `-`, ≤254 bytes,
//                            at most one `@`, not leading/trailing, no `..`
//
// deep_link.rs applies the second one to the `subscriber` action and routes it
// to `/app/subscribers?email=<value>` — a QUERY, not a path segment. The TS
// parseDeepLink applies the id-only rule to every action, so
// `moosewave://subscriber/user@example.com` is accepted by desktop's native
// handler and REJECTED by the shared TS parser that desktop's own notification
// layer, mobile's QR scanner and mobile's deep-link router all use.
//
// This file pins what IS mirrored and records what is not, so the gap is a
// checked fact rather than a comment nobody re-reads. It deliberately does not
// widen the TS parser: doing that alone regresses mobile, because
// routeForEntityLink (apps/mobile/src/lib/deepLinks.ts) only falls through to
// its nav-manifest grammar when parsing returns NULL. A parse that succeeds and
// then yields no path returns null *and* skips the fallback. Closing it
// properly needs an email-addressing model in the registry, which is a product
// decision about whether web and mobile address subscribers by email at all.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { isSafeResourceId } from "./entities.js";
import { parseDeepLink } from "./links.js";

const RUST = resolve(
  process.cwd(),
  "../../apps/desktop/src-tauri/src/deep_link.rs",
);

function rustSource(): string {
  return readFileSync(RUST, "utf8");
}

describe("TS id validation against the Rust parser it mirrors", () => {
  it("still finds both Rust validators", () => {
    // Guard the guard: renamed or deleted Rust functions must fail loudly
    // rather than leave every assertion below vacuously true.
    const src = rustSource();
    expect(src).toContain("fn is_resource_id(");
    expect(src).toContain("fn is_subscriber_target(");
  });

  it("matches is_resource_id's alphabet and length cap", () => {
    const src = rustSource();
    const fn = /fn is_resource_id\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
    expect(fn, "is_resource_id body not extracted").not.toBe("");

    // Rust: is_ascii_alphanumeric() || '-' | '_'
    expect(fn).toContain("is_ascii_alphanumeric()");
    expect(fn).toMatch(/b'-'\s*\|\s*b'_'/);
    expect(fn).toContain("MAX_RESOURCE_ID_BYTES");

    const cap = /const MAX_RESOURCE_ID_BYTES: usize = (\d+);/.exec(src)?.[1];
    expect(cap, "MAX_RESOURCE_ID_BYTES not found").toBeDefined();

    // The TS side must agree on both.
    expect(isSafeResourceId("a".repeat(Number(cap)))).toBe(true);
    expect(isSafeResourceId("a".repeat(Number(cap) + 1))).toBe(false);
    for (const ok of ["abc", "ABC", "a-b", "a_b", "0", "a1-B_2"]) {
      expect(isSafeResourceId(ok), ok).toBe(true);
    }
    for (const bad of ["a b", "a/b", "..", "a.b", "a@b", "a+b", "a%20", ""]) {
      expect(isSafeResourceId(bad), bad).toBe(false);
    }
  });

  it("records that subscriber-by-email parses on Rust but not in TS", () => {
    // Rust's subscriber arm accepts this; the shared TS parser does not. When
    // that is closed, this expectation flips — and whoever closes it must also
    // give the path builders an email-capable route, or mobile's fallback
    // grammar is skipped for links that then resolve nowhere.
    const src = rustSource();
    expect(src).toContain("is_subscriber_target(subscriber)");
    expect(src).toContain("/app/subscribers?email=");

    expect(parseDeepLink("moosewave://subscriber/user@example.com")).toBeNull();
    // The id-shaped form works on both sides today.
    expect(parseDeepLink("moosewave://subscriber/sub-1")).toEqual({
      entity: "subscriber",
      id: "sub-1",
    });
  });

  it("keeps the TS parser at least as strict as Rust for path-segment ids", () => {
    // Whatever the gap above, the TS side must never ACCEPT something Rust
    // rejects for a path-interpolated id — that is the direction that turns a
    // link into a traversal or a smuggled second segment.
    for (const hostile of [
      "moosewave://campaign/../../etc/passwd",
      "moosewave://campaign/a%2Fb",
      "moosewave://campaign/a b",
      "moosewave://campaign/a/b",
      "moosewave://campaign//id",
      "moosewave://campaign/",
    ]) {
      expect(parseDeepLink(hostile), hostile).toBeNull();
    }
  });
});
