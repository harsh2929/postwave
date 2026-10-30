// SPDX-License-Identifier: AGPL-3.0-only
//
// The AIVS proof bundle is the one audit download whose body is BINARY, so it
// goes out through `fetchBlobAuthed` rather than `api.get`. That puts it
// outside client-calls-mounted-routes.test.ts, which only audits `api.*` call
// sites — the path could rot against the gateway with nothing to notice.
//
// This closes that hole for the one route: the path the client actually builds
// is matched against the repository's authoritative gateway inventory, the
// same source the api.* audit uses.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { compileGatewayRouteMatcher } from "../helpers/client-route-audit";

const mocks = vi.hoisted(() => ({ fetchBlobAuthed: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchBlobAuthed: mocks.fetchBlobAuthed };
});

import { downloadAIVSBundle } from "@/lib/audit-compliance-api";

interface GatewayInventoryModule {
  gatewayRouteInventory(repoRoot: string): { routes: Set<string> };
}

const REPO_ROOT = resolve(process.cwd(), "../..");
const reachability = (await import(
  /* @vite-ignore */ pathToFileURL(
    resolve(REPO_ROOT, "scripts/lib/route-reachability.mjs"),
  ).href
)) as GatewayInventoryModule;
const matcher = compileGatewayRouteMatcher(
  reachability.gatewayRouteInventory(REPO_ROOT).routes,
);

beforeEach(() => {
  mocks.fetchBlobAuthed.mockReset();
  mocks.fetchBlobAuthed.mockResolvedValue({
    blob: new Blob(["bundle"]),
    filename: "bundle.tar.gz",
  });
});

/**
 * The matcher needs to be told which segment the client substituted, the way
 * the TypeScript audit tells it. Derived from the encoded id the call actually
 * put on the wire rather than a hardcoded index, so a path-shape change moves
 * the marker with it instead of quietly matching the wrong template.
 */
function resolved(path: string, encodedId: string) {
  const segments = path.split("/").slice(1);
  return {
    value: path,
    bindableSegments: segments.flatMap((segment, index) =>
      segment === encodedId ? [index] : [],
    ),
  };
}

describe("the AIVS bundle download reaches a mounted gateway route", () => {
  it("builds a GET path the gateway actually serves", async () => {
    await downloadAIVSBundle("sess-1");

    const path = mocks.fetchBlobAuthed.mock.calls[0]?.[0] as string;
    expect(path).toBe("/api/v1/audit/ai-session/sess-1/aivs-bundle");
    const match = matcher.match("GET", resolved(path, "sess-1"));
    expect({ mounted: match.mounted, route: match.route }).toEqual({
      mounted: true,
      route: "GET /api/v1/audit/ai-session/{session_id}/aivs-bundle",
    });
  });

  it("percent-encodes a session id so a slash cannot invent a path segment", async () => {
    await downloadAIVSBundle(" tenant/one ");

    const path = mocks.fetchBlobAuthed.mock.calls[0]?.[0] as string;
    expect(path).toBe("/api/v1/audit/ai-session/tenant%2Fone/aivs-bundle");
    expect(matcher.match("GET", resolved(path, "tenant%2Fone")).mounted).toBe(
      true,
    );
  });

  it("sends the Accept the gzip bundle endpoint answers with", async () => {
    await downloadAIVSBundle("sess-1");

    expect(mocks.fetchBlobAuthed.mock.calls[0]?.[1]).toEqual({
      accept: "application/gzip",
      signal: undefined,
    });
  });
});
