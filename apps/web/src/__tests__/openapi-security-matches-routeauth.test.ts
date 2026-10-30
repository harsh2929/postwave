// SPDX-License-Identifier: AGPL-3.0-only
//
// Two artifacts describe who may call each route, and nothing compared them:
//
//   apps/api/internal/routeauth/manifest.json   the SERVER's own auth policy,
//                                               generated from route-contracts
//   packages/openapi/openapi.yaml               the PUBLISHED contract, from
//                                               which SDKs and docs are built
//
// They disagreed on 157 routes. The spec declares a global
// `security: [{bearerAuth: []}]`, so any operation without its own `security`
// key inherits it — and 157 routes the manifest marks `exposure: "public"` had
// no key. That published a bearer-token requirement on `/api/health`, on every
// archive RSS/JSON feed and sitemap, and on the approval-decision links people
// open from an email. All of them are called with no credentials by feed
// readers, load balancers and browsers.
//
// Inheritance is why this was invisible: nothing is *written* on those
// operations, so nothing looks wrong when reading the YAML. The requirement
// only appears once the document is resolved — which is exactly what a
// generator does.
//
// The reverse direction matters more and is checked too: a non-public route
// documented as `security: []` tells a reader an authenticated endpoint is
// open.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");
const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
]);

interface RouteRow {
  method: string;
  path: string;
  exposure?: string;
  auth_methods?: string[];
  release_hold_code?: string;
}

interface SpecOperation {
  security?: unknown;
  responses?: Record<string, unknown>;
  "x-postwave-release-hold"?: unknown;
  "x-required-role"?: unknown;
  "x-required-scopes"?: unknown;
}

/**
 * Non-public routes that legitimately carry `security: []`.
 *
 * An entry states WHY the published contract is right and the exposure label
 * is not the whole story. It is not a place to silence a real mismatch.
 */
const SECURITY_NONE_BY_DESIGN: Record<string, string> = {
  "POST /api/v1/auth/cli/device/token":
    "RFC 8628 device-token polling: the credential is the device_code in the request body, not a scheme. OAuth token endpoints are conventionally declared without a security requirement.",
  // These three authenticate by PROVIDER SIGNATURE (or an internal token), which
  // this spec has no security scheme for. `security: []` understates them —
  // recorded here rather than papered over, because inventing a scheme would
  // put a second, unverified description of the auth into the contract.
  "POST /api/internal/feedback/arf":
    "ESP feedback-loop receiver; authenticates by provider signature, which the spec models no scheme for. Understated, not open.",
  "POST /api/internal/feedback/postmark":
    "Postmark feedback-loop receiver; authenticates by provider signature, which the spec models no scheme for. Understated, not open.",
  "POST /api/internal/feedback/sendgrid":
    "SendGrid feedback-loop receiver; authenticates by provider signature, which the spec models no scheme for. Understated, not open.",
};

/**
 * Release holds that deliberately run only after normal authentication and an
 * exact admin gate. Most held route families stop before authentication and
 * therefore publish `security: []`; these exceptions must retain both their
 * auth errors and their terminal 503 contract.
 */
const AUTHENTICATED_RELEASE_HOLDS: Record<string, string> = {
  "POST /api/v1/subscribers/{id}/notes/{note}/attachments":
    "The upload hold is tenant-and-note scoped and exact-admin gated before returning 503, so unauthorized callers still receive 401/403.",
};

function loadSpec(): Record<string, Record<string, SpecOperation>> {
  const raw = readFileSync(
    resolve(REPO, "packages/openapi/openapi.json"),
    "utf8",
  );
  return (
    JSON.parse(raw) as {
      paths: Record<string, Record<string, SpecOperation>>;
    }
  ).paths;
}

function loadManifest(): RouteRow[] {
  const raw = readFileSync(
    resolve(REPO, "apps/api/internal/routeauth/manifest.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw) as RouteRow[] | { routes: RouteRow[] };
  return Array.isArray(parsed) ? parsed : parsed.routes;
}

function specOperations(): Map<string, SpecOperation> {
  const out = new Map<string, SpecOperation>();
  for (const [path, item] of Object.entries(loadSpec())) {
    for (const [method, op] of Object.entries(item)) {
      if (HTTP_METHODS.has(method))
        out.set(`${method.toUpperCase()} ${path}`, op);
    }
  }
  return out;
}

describe("published security matches the server's route-auth policy", () => {
  const manifest = loadManifest();
  const ops = specOperations();

  it("reads both artifacts", () => {
    // Guard the guard: either file failing to load leaves the sweeps below
    // comparing empty sets, which passes trivially.
    expect(manifest.length).toBeGreaterThan(500);
    expect(ops.size).toBeGreaterThan(500);
    expect(manifest.some((r) => r.exposure === "public")).toBe(true);
  });

  it("declares every public route as callable without a scheme", () => {
    // `security: []` is OpenAPI's way of opting an operation out of the global
    // requirement. Omitting the key INHERITS it, which is the opposite.
    const wrong = manifest
      .filter((r) => r.exposure === "public")
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => ops.has(key))
      .filter((key) => JSON.stringify(ops.get(key)!.security) !== "[]");
    expect(
      wrong,
      "these routes are public on the server but published as requiring bearerAuth",
    ).toEqual([]);
  });

  it("does not publish an auth-bound route as open", () => {
    const wrong = manifest
      .filter((r) => r.exposure !== "public" && r.exposure !== "release-held")
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => ops.has(key))
      .filter((key) => JSON.stringify(ops.get(key)!.security) === "[]")
      .filter((key) => !(key in SECURITY_NONE_BY_DESIGN));
    expect(
      wrong,
      "these routes require auth on the server but are published as open",
    ).toEqual([]);
  });

  it("publishes each release hold at its declared authentication boundary", () => {
    const held = manifest.filter((r) => r.exposure === "release-held");
    const documented = held.filter((row) =>
      ops.has(`${row.method} ${row.path}`),
    );

    expect(held.length).toBeGreaterThan(0);
    expect(documented.length).toBeGreaterThan(0);
    for (const row of held) {
      const key = `${row.method} ${row.path}`;
      expect(row.release_hold_code, key).toMatch(/^[a-z0-9_]+$/u);
      if (!(key in AUTHENTICATED_RELEASE_HOLDS)) {
        expect(row.auth_methods, key).toEqual(["pre_auth_release_hold"]);
      }
    }
    for (const row of documented) {
      const key = `${row.method} ${row.path}`;
      const operation = ops.get(key)!;
      expect(operation["x-postwave-release-hold"], key).toBe(
        row.release_hold_code,
      );
      if (key in AUTHENTICATED_RELEASE_HOLDS) {
        expect(operation.security, key).toEqual([
          { bearerAuth: [] },
          { sessionCookie: [] },
        ]);
        expect(operation["x-required-role"], key).toBe("admin");
        expect(operation["x-required-scopes"], key).toEqual(["admin"]);
        expect(Object.keys(operation.responses ?? {}), key).toEqual([
          "401",
          "403",
          "503",
        ]);
      } else {
        // A pre-auth/public hold must not inherit the document's bearer
        // requirement. This branch intentionally stays strict: adding an auth
        // scheme to an open hold is a contract regression, not a new default.
        expect(operation.security, key).toEqual([]);
        expect(Object.keys(operation.responses ?? {}), key).toEqual(["503"]);
      }
    }
  });

  it("keeps the by-design list honest", () => {
    // An entry that no longer matches reality is stale reasoning, and the
    // justification beside it has stopped being true.
    for (const [key, why] of Object.entries(SECURITY_NONE_BY_DESIGN)) {
      expect(ops.has(key), `${key} is exempted but is not in the spec`).toBe(
        true,
      );
      expect(
        JSON.stringify(ops.get(key)!.security),
        `${key} is exempted but no longer declares security: []`,
      ).toBe("[]");
      expect(why.length, `${key} needs a justification`).toBeGreaterThan(30);
    }

    for (const [key, why] of Object.entries(AUTHENTICATED_RELEASE_HOLDS)) {
      const row = manifest.find(
        (candidate) => `${candidate.method} ${candidate.path}` === key,
      );
      expect(row?.exposure, `${key} is exempted but is not release-held`).toBe(
        "release-held",
      );
      expect(ops.has(key), `${key} is exempted but is not in the spec`).toBe(
        true,
      );
      expect(why.length, `${key} needs a justification`).toBeGreaterThan(30);
    }
  });

  it("keeps the JSON mirror in step with the YAML", () => {
    // openapi.json is generated from openapi.yaml by scripts/yaml-to-json.py.
    // Editing one without regenerating the other publishes two contracts.
    const json = JSON.parse(
      readFileSync(resolve(REPO, "packages/openapi/openapi.json"), "utf8"),
    ) as { paths: Record<string, unknown> };
    const mirror = JSON.parse(
      readFileSync(
        resolve(REPO, "apps/api/internal/apidocs/openapi.json"),
        "utf8",
      ),
    ) as { paths: Record<string, unknown> };
    expect(Object.keys(mirror.paths).length).toBe(
      Object.keys(json.paths).length,
    );
    expect(mirror).toEqual(json);
  });
});
