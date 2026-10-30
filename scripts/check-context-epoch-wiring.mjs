#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// The context epoch is a chain, and every link is a single call site.
//
// The server derives one token per (tenant, tier, user, effective role, MFA)
// and stamps it on every authenticated response; each client observes it on its
// transport, stamps it on queued writes, refuses a write whose context has
// moved, and drops caches when it changes. Each of those is ONE line, and a
// deleted line is invisible to the behavioural tests either side of it — an
// adversarial review deleted five of them and every suite stayed green:
//
//   * main.go's stack member replaced by a passthrough — the server emits
//     NOTHING, and the middleware's own test still passes because it builds
//     its own one-middleware chain.
//   * mobile's only `observeContextEpoch` call deleted — 6496 tests passed.
//   * desktop's enqueue stamp deleted — 6033 tests passed.
//   * desktop's `wireContextEpochCacheReset()` call commented out — passed.
//   * web's cache-reset subscription deleted — 1720 tests passed.
//
// A behavioural test proves a function WORKS. It cannot prove anything CALLS
// it. That is what this guard is for, and it is deliberately a source check:
// the question is literally "is this line present", not "what does it do".
//
// Run: node scripts/check-context-epoch-wiring.mjs [--self-test]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each link: the file, a human name, and the pattern that must appear.
 *
 * `why` is the failure in product terms — what a person experiences when this
 * one line is missing — because a guard that only says "pattern not found"
 * teaches the next reader nothing about whether to restore it or delete it.
 */
const LINKS = [
  {
    name: "server: the stamper is the real middleware, not a passthrough",
    file: "apps/api/main.go",
    pattern: /stampContextEpoch:\s*middleware\.ContextEpochMiddleware\(/,
    why:
      "the server emits no epoch at all, so every client's guard is inert and " +
      "no cache is ever dropped — while all the tests either side keep passing",
  },
  {
    name: "server: the stamper is applied in the authenticated stack",
    file: "apps/api/authenticated_route_stack.go",
    pattern: /router\.Use\(s\.stampContextEpoch\)/,
    why: "the middleware exists and is constructed but never runs",
  },
  {
    name: "web: the transport observes the header",
    file: "apps/web/src/lib/api.ts",
    pattern: /observeContextEpoch\(res\.headers\.get\(CONTEXT_EPOCH_HEADER\)\)/,
    why: "the client never learns the context moved; queued writes replay under it",
  },
  {
    name: "web: queued writes are stamped",
    file: "apps/web/src/lib/offline-store.ts",
    pattern: /contextEpoch:\s*readContextEpoch\(\)/,
    why: "nothing records which context a write was made in, so none can be judged",
  },
  {
    name: "web: the store preserves the field through its sanitizer",
    file: "apps/web/src/lib/offline-store.ts",
    pattern: /contextEpoch:\s*record\.contextEpoch/,
    why:
      "the field is dropped on the way to storage — the same way the tombstone " +
      "rule's `resource` was, which made that rule return false for every mutation",
  },
  {
    name: "web: the drain refuses a moved context",
    file: "apps/web/src/lib/outbox.ts",
    pattern: /isStaleContext\(item,\s*epoch\)/,
    why: "a write replays as whoever is signed in now, not who queued it",
  },
  {
    name: "web: the cache is dropped on change",
    file: "apps/web/src/components/query-provider.tsx",
    pattern: /subscribeContextEpochCacheReset\(/,
    why:
      "a demoted user keeps a cache full of answers computed under permissions " +
      "they no longer have, behind buttons the UI still offers",
  },
  {
    name: "desktop: all three transports observe the header",
    // Counted, not matched by comment text. The first version of this wiring
    // sat ONLY in `authRequest`, which serves `/api/v1/auth/*` — so the epoch
    // was learned at sign-in and never refreshed. Desktop reaches the server
    // three ways (requestInternal, the outbox replay transport, authRequest);
    // all three must observe, or there is a path that silently learns nothing.
    file: "apps/desktop/src/lib/api-client.ts",
    pattern: /observeContextEpoch\(/,
    minCount: 3,
    why:
      "observed on only some transports, the epoch goes stale on the others — " +
      "and if the missing one is the data path, the case this exists for (a " +
      "demotion while the window stays open) is never noticed",
  },
  {
    name: "desktop: queued writes are stamped",
    file: "apps/desktop/src/lib/offline-store.ts",
    pattern: /contextEpoch:\s*readContextEpoch\(\)/,
    why: "nothing records which context a write was made in",
  },
  {
    name: "desktop: the store preserves the field through its sanitizer",
    file: "apps/desktop/src/lib/offline-store.ts",
    pattern: /contextEpoch:\s*record\.contextEpoch/,
    why: "the field is dropped on the way to the encrypted vault",
  },
  {
    name: "desktop: the drain refuses a moved context",
    file: "apps/desktop/src/lib/outbox.ts",
    pattern: /isStaleContext\(item,\s*epoch\)/,
    why: "a queue that outlived a role change replays under the new one",
  },
  {
    name: "desktop: the cache reset is wired at launch",
    file: "apps/desktop/src/App.tsx",
    pattern: /^\s*wireContextEpochCacheReset\(\);/m,
    why:
      "desktop's QueryClient is a module singleton created once at launch, so " +
      "nothing else rebuilds it when a role or plan changes under an open window",
  },
  {
    name: "mobile: the transport observes the header",
    file: "apps/mobile/src/api/sdkClient.ts",
    // The RECEIVER IS NOT PINNED, deliberately. This read `response.headers`
    // until the step-up port extracted the fetch into a `send(init)` closure so
    // a challenged request could be retried after a proof — which observes the
    // epoch on the retry too, i.e. strictly better than before. The guard failed
    // anyway, because it was asserting a variable name rather than the
    // behaviour, and a guard that breaks on a correct refactor teaches people to
    // edit the guard instead of reading it.
    //
    // What still has to hold: observeContextEpoch is called with the header
    // constant read off SOME response's headers, in this file, on the wrapper
    // every SDK request funnels through.
    pattern: /observeContextEpoch\(\s*\w+\.headers\.get\(CONTEXT_EPOCH_HEADER\)\s*\)/,
    why: "the app never learns the context moved",
  },
  {
    name: "mobile: queued scopes are stamped",
    file: "apps/mobile/src/lib/offlineMutationScope.ts",
    pattern: /contextEpoch:\s*epoch/,
    why: "nothing records which context a write was made in",
  },
  {
    name: "mobile: replay refuses a moved context",
    file: "apps/mobile/src/lib/offlineMutationScope.ts",
    pattern: /isStaleContext\(auth,\s*readContextEpoch\(\)\)/,
    why: "a write replays under permissions the person no longer has",
  },
  {
    name: "mobile: the cache reset is wired to the real client",
    file: "apps/mobile/src/lib/queryClient.ts",
    pattern: /wireContextEpochCacheReset\(queryClient\)/,
    why:
      "mobile persists its query cache, so without this a demoted user keeps " +
      "answers computed under their old permissions across app restarts — the " +
      "longest-lived version of this failure, since a phone app is rarely closed",
  },
  {
    name: "every surface reconciles a REHYDRATED cache, not only a mid-session move",
    // Three separate files must each consult the shared rule. A move-only
    // listener structurally cannot catch a change that happened while the app
    // was closed: the cache buster is version:user:tenant, byte-identical
    // either side of a demotion, so the first response of the new session is a
    // first sighting rather than a change.
    file: "packages/offline-outbox/src/context-epoch.ts",
    pattern: /export function decideCacheForEpoch/,
    why:
      "each surface re-derives when a persisted cache is stale, and they drift — " +
      "which is the defect class this package exists to remove",
  },
  {
    name: "the Tauri broker does not strip the header",
    // Found the hard way: the broker filters every response header through a
    // 15-name allowlist, and both native transports funnel through it. Without
    // this entry the header never reaches the TypeScript side in a packaged
    // build, so desktop's whole chain is inert while every unit test and every
    // other link here stays green — they all exercise `fetch`, not this list.
    file: "apps/desktop/src-tauri/src/api_broker.rs",
    pattern: /"x-postwave-context-epoch"/,
    why:
      "desktop observes nothing in a packaged build; the surface that holds " +
      "queued writes longest is the one where the feature does not run",
  },
  {
    name: "CORS exposes the header to cross-origin callers",
    // The desktop shell fetches from `tauri://localhost`. A response header not
    // named in Access-Control-Expose-Headers is invisible to the caller, so
    // this strips it a second, independent time.
    file: "apps/api/main.go",
    pattern: /middleware\.ContextEpochHeader,/,
    why: "cross-origin clients cannot read the header even when it is sent",
  },
  {
    name: "web reconciles the persisted cache",
    file: "apps/web/src/lib/context-epoch.ts",
    pattern: /decideCacheForEpoch\(/,
    why: "a cache written before a demotion rehydrates and paints after a reload",
  },
  {
    name: "desktop reconciles the persisted cache",
    file: "apps/desktop/src/lib/context-epoch.ts",
    pattern: /decideCacheForEpoch\(/,
    why: "an 8-hour persisted cache from before a demotion rehydrates on relaunch",
  },
  {
    name: "mobile reconciles the persisted cache",
    file: "apps/mobile/src/lib/contextEpoch.ts",
    pattern: /decideCacheForEpoch\(/,
    why: "a persisted cache from before a demotion survives an app restart",
  },
];

function read(file) {
  return readFileSync(resolve(repoRoot, file), "utf8");
}

/** Strips line and block comments so a commented-out call cannot satisfy a link. */
export function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    // STRING LITERALS FIRST. Without this, the `//` inside a URL such as
    // "https://api.example" opens a line comment and deletes the rest of that
    // line — which is how the first version of this guard reported main.go's
    // wiring as missing when it was plainly there. A `/*` inside a string would
    // do far worse, swallowing everything to the next `*/` anywhere in the file.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      if (end === -1) return out;
      out += "\n";
      i = end + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return out;
      i = end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The header name is written out in four places — one Go constant and three TS
 * constants — and nothing compares them.
 *
 * This is the guard-defeat that matters: change ONE of them and the feature is
 * dead end to end, while every pattern here still matches, every Go test still
 * uses the symbol `ContextEpochHeader`, and every TS test still uses
 * `CONTEXT_EPOCH_HEADER`. Nothing anywhere would fail. A found instance of
 * exactly this class — the Tauri allowlist — is a link above.
 */
const HEADER_NAME_SITES = [
  { file: "apps/api/internal/middleware/context_epoch.go", pattern: /ContextEpochHeader\s*=\s*"([^"]+)"/ },
  { file: "apps/web/src/lib/context-epoch.ts", pattern: /CONTEXT_EPOCH_HEADER\s*=\s*"([^"]+)"/ },
  { file: "apps/desktop/src/lib/context-epoch.ts", pattern: /CONTEXT_EPOCH_HEADER\s*=\s*"([^"]+)"/ },
  { file: "apps/mobile/src/lib/contextEpoch.ts", pattern: /CONTEXT_EPOCH_HEADER\s*=\s*"([^"]+)"/ },
  { file: "apps/desktop/src-tauri/src/api_broker.rs", pattern: /"(x-postwave-context-epoch)"/ },
];

export function checkHeaderName(sites = HEADER_NAME_SITES, reader = read) {
  const found = [];
  for (const site of sites) {
    let source;
    try {
      source = reader(site.file);
    } catch {
      return [{ file: site.file, detail: "file not found" }];
    }
    const m = source.match(site.pattern);
    if (!m) return [{ file: site.file, detail: "header constant not found" }];
    found.push({ file: site.file, value: m[1].toLowerCase() });
  }
  const distinct = [...new Set(found.map((f) => f.value))];
  if (distinct.length > 1) {
    return found.map((f) => ({ file: f.file, detail: `declares "${f.value}"` }));
  }
  return [];
}

export function checkLinks(links, reader = read) {
  const broken = [];
  for (const link of links) {
    let source;
    try {
      source = stripComments(reader(link.file));
    } catch {
      broken.push({ ...link, detail: "file not found" });
      continue;
    }
    // Rebuild from `.source` + the ORIGINAL flags. `new RegExp(re, "g")`
    // silently DISCARDS the pattern's own flags, which quietly dropped the `m`
    // from a multiline anchor and reported a present call site as missing.
    const flags = link.pattern.flags.includes("g")
      ? link.pattern.flags
      : link.pattern.flags + "g";
    const found = source.match(new RegExp(link.pattern.source, flags))?.length ?? 0;
    const need = link.minCount ?? 1;
    if (found < need) {
      broken.push({
        ...link,
        detail:
          need === 1
            ? "call site missing"
            : `found ${found} call site(s), needs ${need}`,
      });
    }
  }
  return broken;
}

function selfTest() {
  const cases = [];
  const ok = (name, pass, detail) => cases.push({ name, pass, detail });

  // A present call site passes.
  ok(
    "present call site passes",
    checkLinks(
      [{ name: "x", file: "f", pattern: /doThing\(\)/, why: "" }],
      () => "doThing();",
    ).length === 0,
  );

  // A missing one fails.
  ok(
    "missing call site fails",
    checkLinks(
      [{ name: "x", file: "f", pattern: /doThing\(\)/, why: "" }],
      () => "somethingElse();",
    ).length === 1,
  );

  // A COMMENTED-OUT call site fails — this is the exact mutation the review
  // used on desktop's App.tsx, and a naive grep would call it wired.
  ok(
    "commented-out call site fails",
    checkLinks(
      [{ name: "x", file: "f", pattern: /doThing\(\)/, why: "" }],
      () => "// doThing();",
    ).length === 1,
  );

  ok(
    "block-commented call site fails",
    checkLinks(
      [{ name: "x", file: "f", pattern: /doThing\(\)/, why: "" }],
      () => "/* doThing(); */",
    ).length === 1,
  );

  // A `/*` inside a LINE comment must not open a block and swallow the real
  // call below it.
  ok(
    "a glob in a line comment does not swallow the code beneath it",
    checkLinks(
      [{ name: "x", file: "f", pattern: /doThing\(\)/, why: "" }],
      () => "// matches /api/v1/*\ndoThing();\n",
    ).length === 0,
  );

  // Flags on the pattern must survive. Dropping `m` turned a present call site
  // into a reported failure, which is the way this guard fails DANGEROUSLY:
  // a false alarm trains the next reader to distrust it.
  ok(
    "a multiline-anchored pattern still matches",
    checkLinks(
      [{ name: "x", file: "f", pattern: /^doThing\(\);/m, why: "" }],
      () => "const a = 1;\ndoThing();\n",
    ).length === 0,
  );

  // The header name must agree across every surface.
  ok(
    "matching header constants pass",
    checkHeaderName(
      [
        { file: "a", pattern: /H\s*=\s*"([^"]+)"/ },
        { file: "b", pattern: /H\s*=\s*"([^"]+)"/ },
      ],
      () => 'H = "x-thing"',
    ).length === 0,
  );
  ok(
    "a single drifted header constant fails",
    checkHeaderName(
      [
        { file: "a", pattern: /H\s*=\s*"([^"]+)"/ },
        { file: "b", pattern: /H\s*=\s*"([^"]+)"/ },
      ],
      (f) => (f === "a" ? 'H = "x-thing"' : 'H = "x-other"'),
    ).length > 0,
  );

  // A missing file is a broken link, not a silent pass.
  ok(
    "missing file fails",
    checkLinks(
      [{ name: "x", file: "nope", pattern: /doThing\(\)/, why: "" }],
      () => {
        throw new Error("ENOENT");
      },
    ).length === 1,
  );

  const failed = cases.filter((c) => !c.pass);
  for (const c of cases) {
    console.log(`${c.pass ? "  ok  " : "  FAIL"}  ${c.name}`);
  }
  if (failed.length > 0) {
    console.error(`\nself-test: ${failed.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`\nself-test: ${cases.length}/${cases.length} passed`);
}


// apps/ops is DELIBERATELY not in the list above, and this records why.
//
// An ecosystem audit flagged "apps/ops has no context epoch" as a gap. It is
// not one. The epoch exists to DROP CACHES when the identity context behind
// them changes — a queued write, a rehydrated query cache, a stale tenant view.
// apps/ops holds none of those: it has exactly two fetch sites, both
// `cache: "no-store"`, no react-query, no localStorage and no IndexedDB. There
// is nothing for an epoch to invalidate, and stamping one would be ceremony.
//
// BUT SILENCE IS NOT A DECISION — the blueprint's own completeness rule says a
// row that does not apply must say why, and an absence with no reason attached
// is indistinguishable from an oversight (which is exactly how the audit read
// it). So the reason is written down here, and it EXPIRES: this asserts that
// ops still has no cache. The day someone adds react-query, a persisted store,
// or a fetch without `no-store`, this fails and the exemption has to be
// re-argued rather than silently inherited.
const OPS_CACHE_MARKERS = [
  { pattern: /@tanstack\/react-query/, what: "a react-query client" },
  { pattern: /\blocalStorage\b/, what: "localStorage" },
  { pattern: /\bindexedDB\b/i, what: "IndexedDB" },
  { pattern: /\bsessionStorage\b/, what: "sessionStorage" },
];

function checkOpsRemainsCacheFree() {
  const opsSrc = resolve(repoRoot, "apps/ops/src");
  if (!existsSync(opsSrc)) return [];
  const findings = [];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(opsSrc);

  // A floor: scanning nothing would report "still cache-free", which is the
  // reassuring answer and the wrong one.
  if (files.length < 20) {
    findings.push({
      file: "apps/ops/src",
      detail: `scanned only ${files.length} files; expected at least 20`,
      why:
        "this check cannot tell 'ops has no cache' from 'the scan failed', so it " +
        "refuses to report the exemption as still valid",
    });
    return findings;
  }

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const marker of OPS_CACHE_MARKERS) {
      if (marker.pattern.test(source)) {
        findings.push({
          file: file.slice(repoRoot.length + 1),
          detail: `introduces ${marker.what}`,
          why:
            "apps/ops is exempt from the context-epoch fence only because it " +
            "caches nothing. Something that survives an identity change now " +
            "exists here, so either drop it or wire ops into the epoch and add " +
            "its call sites to LINKS above.",
        });
      }
    }
    // NO FETCH-CACHE HEURISTIC HERE, and that is a considered omission rather
    // than an oversight. A first version flagged any file containing `fetch(`
    // without `cache: "no-store"`, and it fired on four client components whose
    // calls are browser POSTs — which Next's fetch cache does not govern at all,
    // and which are never cached regardless. Four false positives out of four.
    //
    // A guard that cries wolf gets edited or disabled, which costs more than the
    // narrow case it might have caught. The markers above are unambiguous: each
    // is state that deliberately OUTLIVES a request, which is the only kind an
    // epoch has anything to say about. The two server-side fetches in
    // apps/ops/src/lib are both `cache: "no-store"` today; if that ever changes
    // it is a Next caching question, not a context-epoch one.
  }
  return findings;
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const nameMismatch = checkHeaderName();
  if (nameMismatch.length > 0) {
    console.error(
      "The context-epoch header name disagrees across surfaces. One changed " +
        "constant kills the feature end to end while every call site below " +
        "still matches:\n",
    );
    for (const m of nameMismatch) console.error(`  ✗ ${m.file}: ${m.detail}`);
    process.exit(1);
  }
  const broken = checkLinks(LINKS);
  if (broken.length > 0) {
    console.error("Context-epoch wiring is broken:\n");
    for (const b of broken) {
      console.error(`  ✗ ${b.name}`);
      console.error(`      ${b.file}: ${b.detail}`);
      console.error(`      consequence: ${b.why}\n`);
    }
    console.error(
      `${broken.length} of ${LINKS.length} links broken. Each is one call site; ` +
        `the behavioural tests either side of it pass regardless.`,
    );
    process.exit(1);
  }
  const opsDrift = checkOpsRemainsCacheFree();
  if (opsDrift.length > 0) {
    console.error(
      "apps/ops is exempt from the context-epoch fence because it caches " +
        "nothing. That is no longer true:\n",
    );
    for (const d of opsDrift) {
      console.error(`  ✗ ${d.file}: ${d.detail}`);
      console.error(`      ${d.why}\n`);
    }
    process.exit(1);
  }
  console.log(
    `Context-epoch wiring: ${LINKS.length}/${LINKS.length} links present; ` +
      `apps/ops exempt and still cache-free.`,
  );
}
