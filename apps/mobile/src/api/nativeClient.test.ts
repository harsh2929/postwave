/**
 * The first-party native-client header contract.
 *
 * These two headers are the only thing on the wire that tells the backend this
 * request came from the Moosewave app, and BOTH of them fail SILENTLY and OPEN
 * when they drift — which is exactly why they had no test (NATIVE#51):
 *
 *   - `X-Postwave-Client` is what exempts the app from the browser Origin/CSRF
 *     gate. `apps/api/internal/middleware/origin_csrf.go` looks the value up in
 *     a hard-coded `trustedNativeClients` map; a typo or a rename turns every
 *     state-changing request into a 403 `forbidden_origin`, and nothing on this
 *     side would say why.
 *
 *   - `X-Postwave-Version` drives the minimum-build floor in
 *     `apps/api/internal/middleware/client_version.go`. Its `parseSemver`
 *     FAILS OPEN: a value it cannot parse (the `"dev"` fallback, a two-part
 *     "1.0", a date) skips the check entirely, so a stale build keeps talking
 *     to a gateway that believes it rejected it.
 *
 * There is no shared package between Go and TypeScript here, so the Go source
 * is parsed directly. A refactor this parser cannot read fails loudly rather
 * than passing on an empty set.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import appConfig from "../../app.json";
import { NATIVE_CLIENT_HEADERS } from "./nativeClient";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), "../..", path), "utf8");
}

/** Parse `var trustedNativeClients = map[string]struct{}{ "mobile": {}, ... }`. */
function trustedNativeClients(): Set<string> {
  const source = repoFile("apps/api/internal/middleware/origin_csrf.go");
  const block = /trustedNativeClients\s*=\s*map\[string\]struct\{\}\{([^}]*\}[^}]*)\}/u
    .exec(source)?.[1];
  if (!block) throw new Error("could not locate trustedNativeClients in Go source");
  return new Set(
    [...block.matchAll(/"([a-z_]+)"\s*:/gu)].map((match) => match[1] as string),
  );
}

/** A faithful port of `parseSemver` from client_version.go. */
function goParseSemver(raw: string): boolean {
  let value = raw.trim();
  if (value.startsWith("v")) value = value.slice(1);
  if (value === "") return false;
  const cut = value.search(/[-+]/u);
  if (cut >= 0) value = value.slice(0, cut);
  const parts = value.split(".");
  if (parts.length < 3) return false;
  return parts.slice(0, 3).every((part) => /^\d+$/u.test(part));
}

describe("native client headers", () => {
  it("declares exactly the two headers the gateway reads", () => {
    expect(Object.keys(NATIVE_CLIENT_HEADERS).sort()).toEqual([
      "X-Postwave-Client",
      "X-Postwave-Version",
    ]);
  });

  it("sends a client value the Go CSRF gate actually trusts", () => {
    const trusted = trustedNativeClients();
    // Sanity-check the parser itself before trusting its verdict.
    expect(trusted.size).toBeGreaterThanOrEqual(2);
    expect(trusted.has("desktop")).toBe(true);

    const sent = NATIVE_CLIENT_HEADERS["X-Postwave-Client"] as string;
    // normalizeClient/isTrustedNativeClient lowercase and trim before lookup.
    expect(trusted.has(sent.trim().toLowerCase())).toBe(true);
  });

  it("sends a version the Go floor can actually parse", () => {
    // If this ever fails, the minimum-version gate is silently disabled for
    // every mobile install — the gateway takes the fail-open branch.
    const sent = NATIVE_CLIENT_HEADERS["X-Postwave-Version"] as string;
    expect(sent).not.toBe("dev");
    expect(goParseSemver(sent)).toBe(true);
  });

  it("reports the version the binary actually ships", () => {
    expect(NATIVE_CLIENT_HEADERS["X-Postwave-Version"]).toBe(
      appConfig.expo.version,
    );
  });

  it("keeps both headers on the gateway's allow-list", () => {
    // Not for mobile's own sake — mobile is not a browser — but the same
    // constant is the desktop/web preflight contract, and a rename here would
    // otherwise be caught only in production.
    const main = repoFile("apps/api/main.go");
    for (const header of Object.keys(NATIVE_CLIENT_HEADERS)) {
      expect(main).toContain(`"${header}"`);
    }
  });

  it("pins the port of parseSemver against its known-answer cases", () => {
    // Guards the guard: these are the exact shapes client_version.go accepts
    // and rejects, so a wrong port cannot pass the version assertion above.
    for (const ok of ["1.2.3", "v1.2.3", "0.1.0", "1.2.3-beta.1", "1.2.3+ci"]) {
      expect(goParseSemver(ok)).toBe(true);
    }
    for (const bad of ["", "dev", "1.0", "v", "1.2.x", "2026-07-25"]) {
      expect(goParseSemver(bad)).toBe(false);
    }
  });
});
