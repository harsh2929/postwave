import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), "src", path), "utf8");
}

// The per-page assertions below were written one page at a time, which is
// exactly how the integrations guide rotted while quickstart stayed correct:
// quickstart got a fix for `/api/v1/domains` (and the negative assertion that
// still sits in this file), and the sibling page kept shipping the same dead
// endpoint — plus `PUT /api/v1/sending/{postmark,mailgun}`, which never existed
// at all. Copy-pasteable curl that 404s is worse than no curl.
//
// This sweep is spec-driven instead of hand-listed, so a NEW docs page is
// covered the moment it exists rather than when someone remembers to add a
// line here.
const SPEC_PATHS: string[] = Object.keys(
  (
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), "../../packages/openapi/openapi.json"),
        "utf8",
      ),
    ) as { paths: Record<string, unknown> }
  ).paths,
);

/** Match a concrete path against the spec, treating `{...}` as a wildcard. */
function inSpec(path: string): boolean {
  const want = path.split("/").filter(Boolean);
  return SPEC_PATHS.some((route) => {
    const have = route.split("/").filter(Boolean);
    if (have.length !== want.length) return false;
    return have.every(
      (seg, i) => seg === want[i] || (seg.startsWith("{") && seg.endsWith("}")),
    );
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Endpoints referenced anywhere in docs prose, captions or curl samples. */
function documentedEndpoints(): { endpoint: string; file: string }[] {
  const docsRoot = resolve(process.cwd(), "src/app/(docs)");
  const found: { endpoint: string; file: string }[] = [];
  for (const file of walk(docsRoot)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      /\/api\/(?:v1|internal|public)\/[A-Za-z0-9_\-/{}.$]+/g,
    )) {
      const endpoint = m[0]
        .replace(/\$\{[^}]*\}/g, "{id}") // ${sessionId}
        .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "{id}") // $UPLOAD_ID
        .replace(/[".,\\]+$/, "")
        .replace(/\/$/, "");
      found.push({ endpoint, file: file.slice(docsRoot.length + 1) });
    }
  }
  return found;
}

describe("documentation API examples", () => {
  it("keeps every quickstart curl on a mounted API route", () => {
    const quickstart = source("app/(docs)/docs/quickstart/page.tsx");
    for (const route of [
      "/api/v1/sending-identities",
      "/api/v1/migrations/activecampaign/credentials",
      "/api/v1/migrations/activecampaign/discover",
      "/api/v1/migrations/activecampaign/dry-run",
      "/api/v1/migrations/activecampaign/commit",
      "/api/v1/voice/profile/build",
      "/api/v1/voice/sequences",
      "/api/v1/inbox-reality/campaigns/cmp_42",
    ]) {
      expect(quickstart).toContain(route);
    }
    expect(quickstart).not.toContain("/api/v1/domains");
    expect(quickstart).not.toContain("/api/v1/custom-domains");
    expect(quickstart).not.toContain("/api/v1/voice/build");
    expect(quickstart).not.toContain("/api/v1/sequences/generate");
    expect(quickstart).not.toContain("/api/v1/inbox-reality/cmp_42");
  });

  it("uses source-keyed credential, OAuth, and upload migration routes", () => {
    const guides = source("app/(docs)/docs/migrations/[source]/page.tsx");
    expect(guides).toContain("/migrations/mailchimp/oauth/start");
    for (const sourceName of ["convertkit", "brevo", "beehiiv", "mailerlite"]) {
      expect(guides).toContain(`/migrations/${sourceName}/credentials`);
    }
    for (const sourceName of ["substack", "sendy", "csv"]) {
      expect(guides).toContain(`/migrations/${sourceName}/uploads/$UPLOAD_ID`);
    }
    expect(guides).not.toContain("/api/v1/migrations/$SESSION_ID");
    expect(guides).not.toContain('api/v1/migrations/csv"');
    expect(guides).not.toContain('api/v1/migrations"');
  });

  it("scans a meaningful number of documented endpoints", () => {
    // Guard the guard: if the walk or the regex breaks, the sweep below would
    // pass vacuously by finding nothing to check.
    expect(SPEC_PATHS.length).toBeGreaterThan(100);
    expect(documentedEndpoints().length).toBeGreaterThan(20);
  });

  it("every endpoint referenced in the docs exists in the OpenAPI spec", () => {
    const dead = documentedEndpoints()
      .filter(({ endpoint }) => !inSpec(endpoint))
      .map(({ endpoint, file }) => `${endpoint}  (${file})`);
    expect([...new Set(dead)]).toEqual([]);
  });
});
