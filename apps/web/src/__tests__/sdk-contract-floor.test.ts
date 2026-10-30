// SPDX-License-Identifier: AGPL-3.0-only
//
// Nine published SDKs wrap one API. They are deliberately tiered — sdk-ts,
// sdk-py and sdk-php model typed errors like WrongRegionError, while sdk-go
// and the thinner clients do not, and that is a scope decision rather than a
// gap. What is NOT tiered is the floor every one of them has to meet, because
// a client that misses it is broken for an entire language's users with no
// obvious symptom.
//
// Three floor properties, verified across all nine at the time of writing:
//
//   1. Bearer auth. Every SDK sends `Authorization: Bearer <key>`. One sending
//      a different header authenticates nothing and fails opaquely.
//
//   2. No credential values in errors or logs. These are published packages
//      run against production keys, and their output goes wherever the user's
//      logging goes.
//
//   3. The error envelope's `code` and `message` reach the caller. This is
//      what makes the untyped tier usable: the API answers a misrouted request
//      with 421 and "this tenant's data lives in eu-central-1; retry against
//      https://eu-central-1.api.moosewave.com". An SDK that surfaces only a
//      status code turns a self-explaining error into an unexplained 421 —
//      and 421 is obscure enough that most callers will not recognise it.
//
// Checked statically, from apps/web because it is the one workspace with a
// test runner that already reads across the repo.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = resolve(process.cwd(), "../../packages");

const SDKS = [
  "sdk-ts",
  "sdk-py",
  "sdk-go",
  "sdk-php",
  "sdk-ruby",
  "sdk-rust",
  "sdk-java",
  "sdk-dotnet",
  "sdk-elixir",
] as const;

const SOURCE_EXT = /\.(ts|py|go|php|rb|rs|java|cs|ex)$/;
const SKIP_DIR = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".git",
  "tests",
  "test",
  "spec",
]);

function sourcesOf(sdk: string): { rel: string; text: string }[] {
  const root = join(PACKAGES, sdk);
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (!SKIP_DIR.has(entry)) walk(p);
        continue;
      }
      if (!SOURCE_EXT.test(p) || /(test|spec)\./i.test(entry)) continue;
      out.push({ rel: p.slice(root.length + 1), text: readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out;
}

const CORPUS = new Map(SDKS.map((s) => [s, sourcesOf(s)]));

describe("published SDK contract floor", () => {
  it("reads every SDK", () => {
    // Guard the guard: an SDK that reads as zero files passes every check
    // below, which is precisely how a whole client stops being covered.
    for (const sdk of SDKS) {
      expect(CORPUS.get(sdk)!.length, `${sdk} has no scanned sources`).toBeGreaterThan(0);
    }
  });

  it("authenticates with a Bearer token", () => {
    // Each language spells the header differently — req["Authorization"],
    // {~c"authorization", ...}, .header("Authorization", ...) — so match the
    // scheme rather than any one idiom.
    const missing = SDKS.filter(
      (sdk) =>
        !CORPUS.get(sdk)!.some((f) => /Bearer\s*["'`\s+#{$]|Bearer /.test(f.text)),
    );
    expect(missing).toEqual([]);
  });

  it("puts no credential value into an error or a log", () => {
    // The argument, not the message: "missing API token" names a secret and
    // leaks nothing, while `%s` with a token argument does the reverse.
    const emit =
      /(fmt\.Errorf|errors\.New|log\.|console\.(log|error|warn)|print|puts |raise |throw new|panic!|println!|eprintln!|Console\.|Logger\.)/i;
    // The argument may be qualified — c.apiKey, self.api_key, this._token —
    // so allow a dotted receiver. An earlier version used a bare \w* and
    // silently missed `fmt.Errorf("auth failed for %s", c.apiKey)`, which is
    // the most likely real shape of this bug.
    const QUALIFIED = String.raw`[\w.$@]*`;
    const interpolated = new RegExp(
      [
        String.raw`\$\{[^}]*(token|secret|apiKey|api_key|password)[^}]*\}`,
        String.raw`%[sv][^"]*"\s*,\s*${QUALIFIED}(token|secret|key|password)`,
        String.raw`\+\s*${QUALIFIED}(token|secret|apiKey|password)\b`,
        String.raw`#\{[^}]*(token|secret|api_key|password)[^}]*\}`,
      ].join("|"),
      "i",
    );
    const leaks: string[] = [];
    for (const sdk of SDKS) {
      for (const f of CORPUS.get(sdk)!) {
        for (const [i, line] of f.text.split("\n").entries()) {
          if (emit.test(line) && interpolated.test(line)) {
            leaks.push(`${sdk}/${f.rel}:${i + 1}`);
          }
        }
      }
    }
    expect(leaks.sort()).toEqual([]);
  });

  it("surfaces the API error code and message to the caller", () => {
    // Without this the untyped tier cannot act on wrong_region at all: the
    // endpoint to retry against lives in the message.
    const opaque = SDKS.filter((sdk) => {
      const all = CORPUS.get(sdk)!.map((f) => f.text).join("\n");
      return !(/\bcode\b/i.test(all) && /\bmessage\b/i.test(all));
    });
    expect(opaque).toEqual([]);
  });

  it("keeps the region contract the API actually emits", () => {
    // The typed tier reads `correct_endpoint`; the untyped tier relies on the
    // message. Both break if the server renames the field or drops the host
    // from the sentence, so pin the producer.
    const middleware = readFileSync(
      resolve(process.cwd(), "../../apps/api/internal/regions/middleware.go"),
      "utf8",
    );
    expect(middleware).toContain('"code": "wrong_region"');
    expect(middleware).toContain('"correct_endpoint": correct');
    expect(middleware).toMatch(/retry against %s/);
    expect(middleware).toContain("StatusMisdirectedRequest");

    // Every SDK that names the code must read the field beside it, or it is
    // reporting a region error it cannot tell the caller how to fix.
    for (const sdk of SDKS) {
      const all = CORPUS.get(sdk)!.map((f) => f.text).join("\n");
      if (!/wrong_region|WrongRegion/.test(all)) continue;
      // Word-bounded: `correctEndpointX` contains `correctEndpoint`, so an
      // unbounded match would accept a rename that breaks every caller.
      expect(all, `${sdk} models wrong_region without correct_endpoint`).toMatch(
        /\bcorrect_endpoint\b|\bcorrectEndpoint\b/,
      );
    }
  });
});
