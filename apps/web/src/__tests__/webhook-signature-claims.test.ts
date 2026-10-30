// SPDX-License-Identifier: AGPL-3.0-only
//
// /developers documents the webhook signature contract in both directions.
// It claimed one thing that does not exist:
//
//   "ECDSA P-256 (v2) and Ed25519 (v3) signatures are also available for
//    endpoints that want asymmetric verification."
//
// Outbound delivery has exactly one scheme. dispatcher.go writes
// `t=%d,v1=%s` unconditionally — no branch, no negotiation, no asymmetric
// path. The only asymmetric crypto in the repo is Apple's APNs JWT
// (ecdsa.Sign in pushsend) and VERIFYING Telnyx's inbound SMS webhooks
// (ed25519.Verify in sms) — someone else's signatures, on the receive side.
//
// The claim was also self-colliding: the page correctly documents `v2=` as
// the real INBOUND HMAC version one bullet later, so "v2" meant two different
// things on the same page. A developer choosing Moosewave to avoid
// distributing a shared secret would have built for a scheme that is not
// coming.
//
// What replaced it is a verification recipe, so this test pins the recipe to
// the bytes actually signed rather than to prose.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

const PAGE = readFileSync(
  join(SRC, "app/(marketing)/developers/page.tsx"),
  "utf8",
).replace(/\s+/g, " ");

const DISPATCHER = readFileSync(
  join(REPO, "apps/api/internal/webhooks/dispatcher.go"),
  "utf8",
);

describe("webhook signature claims match the dispatcher", () => {
  it("publishes the header format the dispatcher emits", () => {
    const m = /signature\s*:=\s*fmt\.Sprintf\("t=%d,(v\d)=%s"/.exec(DISPATCHER);
    expect(m, "outbound signature header not found").not.toBeNull();
    expect(DISPATCHER).toContain(
      'req.Header.Set("Moosewave-Signature", signature)',
    );
    expect(DISPATCHER).toContain(
      'req.Header.Set("Postwave-Signature", signature)',
    );
    expect(PAGE).toContain(`t=<unix>,${m![1]}=<hex>`);
  });

  it("publishes the bytes that are actually signed", () => {
    // mac gets "<ts>." then the raw body. A recipe that omits the dot, or
    // signs the parsed body, produces a digest that never matches.
    expect(DISPATCHER).toMatch(/Fprintf\(mac, "%d\."/);
    expect(DISPATCHER).toMatch(/mac\.Write\(wireBody\)/);
    expect(PAGE).toContain("'<t>.' followed by the raw request body");
  });

  it("claims no outbound scheme the dispatcher cannot produce", () => {
    // Every vN the page attaches to an OUTBOUND signature must be one the
    // dispatcher writes. Inbound v2 is a separate contract and is checked
    // below on its own terms.
    const emitted = new Set(
      [...DISPATCHER.matchAll(/"t=%d,(v\d)=%s"/g)].map((x) => x[1]!),
    );
    expect(emitted.size).toBeGreaterThan(0); // guard the guard
    const outbound = /Outbound signatures:[\s\S]{0,400}/.exec(PAGE)?.[0] ?? "";
    expect(outbound).not.toBe("");
    const claimed = [...outbound.matchAll(/\b(v\d)\b/g)].map((x) => x[1]!);
    expect(claimed.filter((v) => !emitted.has(v))).toEqual([]);
  });

  it("does not offer asymmetric webhook verification", () => {
    // No ECDSA or Ed25519 signing exists for Moosewave's own webhook
    // deliveries. Naming a curve here is a promise the dispatcher cannot keep.
    for (const alg of ["ECDSA", "Ed25519", "P-256"]) {
      expect(
        PAGE,
        `page still offers ${alg} webhook verification`,
      ).not.toContain(alg);
    }
    expect(DISPATCHER).not.toMatch(/ecdsa|ed25519/i);
  });

  it("keeps the inbound v2 contract distinct and accurate", () => {
    // Inbound really is v2, really is length-prefixed, and really is HMAC —
    // the page's precision here is correct and worth protecting.
    const auth = readFileSync(
      join(REPO, "apps/api/internal/inbound_webhooks/authentication.go"),
      "utf8",
    );
    expect(auth).toContain("v2=");
    expect(PAGE).toContain("X-Moosewave-Signature = 'v2='");
    expect(PAGE).toContain("length-prefixed");
    // …and the header names really do differ by direction.
    expect(PAGE).toContain("Moosewave verifies X-Moosewave-Signature");
    const handlers = readFileSync(
      join(REPO, "apps/api/internal/inbound_webhooks/handlers.go"),
      "utf8",
    );
    expect(handlers).toContain('r.Header.Get("X-Moosewave-Signature")');
    expect(handlers).toContain('r.Header.Get("X-Postwave-Signature")');
    expect(DISPATCHER).toContain('"Moosewave-Signature"');
  });
});
