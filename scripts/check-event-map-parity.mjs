#!/usr/bin/env node
//
// scripts/check-event-map-parity.mjs
//
// Guards the realtime event→cache-invalidation contract. Before
// @postwave/query-contract owned the topic→resource decision, web, desktop and
// mobile each hand-rolled their own table and DISAGREED (e.g. an `approval.*`
// event refreshed the dashboard+queue on web, the audit feed on desktop, and
// only the queue on mobile). This guard enforces the STRUCTURAL invariant that
// prevents that class of drift from returning: every client derives WHICH
// resources to invalidate from the one shared authority, and types its adapter
// so TypeScript rejects a dropped resource.
//
// Scope — what this DOES and does NOT check:
//   ✓ 1. The shared authority exists and exports canonicalResourcesForEvent +
//        CANONICAL_RESOURCES.
//   ✓ 2. Each client's invalidation module imports canonicalResourcesForEvent
//        from @postwave/query-contract (derives, not hard-codes a topic switch).
//   ✓ 3. Each client types its resource adapter as Record<CanonicalResource,…>,
//        so a dropped resource is a compile error (tsc enforces totality; this
//        verifies the guard rail is present).
//   ✓ 4. NO SILENT EMPTY MAPPING. Record<CanonicalResource,…> totality forces a
//        client to name every resource, but `foo: []` satisfies the compiler
//        while invalidating nothing — the exact shape of a dropped resource,
//        just spelled differently. Any empty entry must be declared in that
//        surface's `*_UNBACKED_RESOURCES` export, and that declaration must
//        agree exactly with the empty entries in the adapter. An opt-out stays
//        legal (web ships no deliverability screen; there is genuinely no key
//        to invalidate) but has to be written down.
//   ✗ It does NOT verify per-surface SUBSCRIPTION sets (legitimately differ —
//     e.g. only mobile subscribes to list.*), that a mapped resource backs a
//     real query on that surface, or byte-for-byte value parity. Those live in
//     each client's unit test + the shared events.test.ts, not here. Mobile's
//     own test asserts the stronger property that every domain it BACKS is also
//     a domain it SUBSCRIBES to.
//
// Run `--self-test` to exercise the checker against synthetic sources.
//
// Exit non-zero on any breach.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const AUTHORITY = "packages/query-contract/src/events.ts";
const GO_STREAM_HANDLER = "apps/api/internal/events/handler.go";

// Client modules that build the `?topics=` CSV. They must NOT re-declare the
// topic grammar — a local copy is how the Go and TS versions silently diverged
// (all three omitted `_` while the gateway published `list_health.degraded`).
const TOPIC_NORMALIZERS = [
  "apps/desktop/src/lib/event-bus-topics.ts",
  "apps/mobile/src/api/event-bus-topics.ts",
  // Web builds its CSV inline rather than in a dedicated module. It used to
  // `topics.join(",")` with no grammar check and no length bound, so an
  // ungrammatical entry was discarded server-side and an oversized CSV would
  // have swapped the whole subscription for the no-match sentinel.
  "apps/web/src/lib/realtime/event-bus-client.ts",
];

// Each client's realtime cache-invalidation module, the local adapter symbol it
// must type as Record<CanonicalResource,…>, and the export that declares which
// canonical resources that surface deliberately does not back.
const CLIENTS = [
  {
    surface: "web",
    file: "apps/web/src/lib/realtime/event-query-map.ts",
    adapter: "WEB_RESOURCE_KEYS",
    unbacked: "WEB_UNBACKED_RESOURCES",
  },
  {
    surface: "desktop",
    file: "apps/desktop/src/lib/cache-invalidator.ts",
    adapter: "DESKTOP_RESOURCE_PREFIXES",
    unbacked: "DESKTOP_UNBACKED_RESOURCES",
  },
  {
    surface: "mobile",
    file: "apps/mobile/src/api/event-cache-invalidation.ts",
    adapter: "MOBILE_RESOURCE_ROOTS",
    unbacked: "MOBILE_UNBACKED_RESOURCES",
  },
];

/**
 * Slice out an object/array literal body by brace matching, starting at the
 * first `open` character after `declSymbol`. Returns "" when the symbol or a
 * balanced close is absent. String/comment contents are not parsed — the
 * adapters are plain literals, and a stray brace inside a comment would only
 * make this return a longer slice, never a wrong verdict about emptiness.
 */
function literalBody(src, declSymbol, open = "{", close = "}") {
  const declIdx = src.indexOf(declSymbol);
  if (declIdx === -1) return "";
  const start = src.indexOf(open, declIdx);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return "";
}

/** Strip line + block comments so a commented-out example never trips a check. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Split an adapter literal body into top-level `key: value` entries.
 *
 * Depth-aware so a nested object/array/parenthesised value or a comma inside a
 * function's parameter list does not end an entry early. Comments are stripped
 * first, and string contents are skipped, so neither can contribute a brace, a
 * comma or a fake key.
 */
function adapterEntries(adapterBody) {
  const src = stripComments(adapterBody);
  const entries = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      entries.push(src.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(src.slice(start));

  const out = [];
  for (const raw of entries) {
    const text = raw.trim();
    if (!text) continue;
    // `key:` / `"key":` / `'key':` — anything else (a spread, a method) is not
    // a resource entry this check reasons about.
    const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:([\s\S]*)$/.exec(
      text,
    );
    if (!m) continue;
    out.push({ key: m[1] ?? m[2] ?? m[3], value: m[4].trim() });
  }
  return out;
}

/**
 * Canonical-resource keys whose adapter value invalidates NOTHING.
 *
 * Inverted on purpose. An earlier revision enumerated the empty spellings it
 * knew about (`[]`, `() => []`, …) and was bypassed by ten more — `[] satisfies
 * readonly string[]` (this repo's own idiom), a quoted key, `Object.freeze([])`,
 * `[...[]]`, `new Array<string>()`, `[].concat()`, `() => ([])`, an empty const
 * imported from another module, and so on. Enumerating "empty" is unbounded;
 * enumerating "non-empty" is not.
 *
 * The approach is normalise-then-match: peel every WRAPPER a value can be
 * dressed in (type assertion, `satisfies`, parens, arrow, `return`, a local
 * const) until only the core expression remains, then compare that core
 * against the small set of expressions that produce nothing. Enumerating
 * wrappers is bounded; enumerating spellings is not.
 *
 * `notificationFeed: (_e, t, r) => [qk.notificationFeed(t, r)]` normalises to a
 * one-element array and is correctly NOT empty, even though it contains no
 * string literal — which is why "must contain a string literal" was the wrong
 * inversion.
 */
const EMPTY_EXPRESSIONS = [
  /^\[\s*\]$/, //                       []
  /^\[\s*\.\.\.\s*\[\s*\]\s*\]$/, //    [...[]]
  /^Object\.freeze\(\s*\[\s*\]\s*\)$/, // Object.freeze([])
  /^new\s+Array\s*(?:<[^>]*>)?\s*\(\s*\)$/, // new Array<string>()
  /^\[\s*\]\s*\.concat\(\s*\)$/, //     [].concat()
  /^$/, //                              nothing at all
];

/** Peel wrappers until only the value-producing expression is left. */
function coreExpression(value, src, hops = 2) {
  let e = value.trim();
  for (let i = 0; i < 6; i += 1) {
    const before = e;
    e = e.replace(/\s+(?:as|satisfies)\s+[\w<>[\](){}|,.\s]+$/, "").trim();
    // Arrow function: keep the body.
    e = e
      .replace(/^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/, "")
      .trim();
    // Block body: keep the returned expression.
    const block = /^\{[\s\S]*?return\s+([\s\S]*?);?\s*\}$/.exec(e);
    if (block) e = block[1].trim();
    // Balanced wrapping parens.
    if (/^\([\s\S]*\)$/.test(e)) {
      const inner = e.slice(1, -1);
      let depth = 0;
      let balanced = true;
      for (const ch of inner) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        if (depth < 0) balanced = false;
      }
      if (balanced && depth === 0) e = inner.trim();
    }
    if (e === before) break;
  }
  // Follow a bare identifier one hop to its declaration.
  if (hops > 0 && /^[A-Za-z_$][\w$]*$/.test(e)) {
    const decl = new RegExp(
      `(?:const|let|var)\\s+${e}\\s*(?::[^=]+)?=\\s*([^;\\n]*)`,
    ).exec(src);
    // No declaration in this file (e.g. an import) — cannot prove it is empty,
    // and a wrong "empty" verdict is a false CI failure. Treat as backed.
    if (!decl) return "IMPORTED_UNRESOLVED";
    return coreExpression(decl[1], src, hops - 1);
  }
  return e;
}

function emptyAdapterEntries(adapterBody, fullSrc = "") {
  const src = stripComments(fullSrc);
  const out = [];
  for (const { key, value } of adapterEntries(adapterBody)) {
    const core = coreExpression(value, src);
    if (EMPTY_EXPRESSIONS.some((re) => re.test(core))) out.push(key);
  }
  return out;
}

/** String literals inside a declared `as const` array export. */
function declaredResources(src, symbol) {
  const body = literalBody(src, `${symbol} = [`, "[", "]");
  if (!body) return [];
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Run every structural check. `read` maps a repo-relative path to source text
 * (or null when unreadable) so the self-test can supply synthetic files.
 * Returns the list of human-readable breaches.
 */
export function runChecks(read) {
  const errors = [];

  const readOrRecord = (relPath) => {
    const src = read(relPath);
    if (src === null || src === undefined) {
      errors.push(`cannot read ${relPath}`);
      return "";
    }
    return src;
  };

  // 1. The shared authority must export the canonical vocabulary + mapping fn.
  const authoritySrc = readOrRecord(AUTHORITY);
  for (const sym of [
    "export const CANONICAL_RESOURCES",
    "export function canonicalResourcesForEvent",
  ]) {
    if (!authoritySrc.includes(sym)) {
      errors.push(
        `${AUTHORITY}: missing \`${sym}\` — the shared authority is incomplete`,
      );
    }
  }

  for (const { surface, file, adapter, unbacked } of CLIENTS) {
    const src = readOrRecord(file);
    if (!src) continue;

    // 2. Derives from the authority rather than hard-coding a topic table.
    if (!src.includes("canonicalResourcesForEvent")) {
      errors.push(
        `${surface} (${file}): does not call canonicalResourcesForEvent — it must ` +
          `derive WHICH resources to invalidate from @postwave/query-contract, ` +
          `not hard-code a topic→resource table.`,
      );
    }
    if (!/from "@postwave\/query-contract"/.test(src)) {
      errors.push(
        `${surface} (${file}): does not import from @postwave/query-contract.`,
      );
    }

    // 3. The adapter must be typed Record<CanonicalResource,…> so TypeScript
    // makes a dropped canonical resource a compile error (the real guard).
    const totalityRe = new RegExp(
      `${adapter}\\s*:\\s*Record<\\s*CanonicalResource`,
    );
    if (!totalityRe.test(src)) {
      errors.push(
        `${surface} (${file}): adapter \`${adapter}\` must be typed ` +
          `Record<CanonicalResource, …> so a dropped resource fails to compile.`,
      );
    }

    // 4. No silent empty mapping. Totality forces every resource to be NAMED;
    // it cannot force it to be BACKED. An empty entry is a legitimate opt-out
    // only when the surface declares it.
    const adapterBody = literalBody(src, adapter);
    if (!adapterBody) {
      errors.push(
        `${surface} (${file}): could not locate the \`${adapter}\` literal body.`,
      );
      continue;
    }
    const empties = [...new Set(emptyAdapterEntries(adapterBody, src))].sort();
    const declared = [...new Set(declaredResources(src, unbacked))].sort();

    if (empties.length > 0 && declared.length === 0) {
      errors.push(
        `${surface} (${file}): \`${adapter}\` maps ${empties
          .map((e) => `\`${e}\``)
          .join(", ")} to nothing but exports no \`${unbacked}\`. An empty ` +
          `entry satisfies Record<CanonicalResource,…> while invalidating ` +
          `nothing — declare it (with the reason this surface has no cache ` +
          `for it) instead of leaving a silent no-op.`,
      );
      continue;
    }
    const missingDecl = empties.filter((e) => !declared.includes(e));
    const staleDecl = declared.filter((d) => !empties.includes(d));
    if (missingDecl.length > 0) {
      errors.push(
        `${surface} (${file}): ${missingDecl
          .map((e) => `\`${e}\``)
          .join(", ")} map to nothing but are absent from \`${unbacked}\`.`,
      );
    }
    if (staleDecl.length > 0) {
      errors.push(
        `${surface} (${file}): \`${unbacked}\` still lists ${staleDecl
          .map((e) => `\`${e}\``)
          .join(", ")}, which now has a real mapping — remove it from the ` +
          `declaration so the opt-out list stays truthful.`,
      );
    }
  }

  // 5. The wire topic grammar is ONE grammar. The gateway's `streamTopicRE`
  // and the shared `EVENT_TOPIC_FILTER_PATTERN` must be character-identical
  // (modulo Go's raw-string vs JS-string escaping), and no client may keep a
  // private copy. When these drifted, a client could name a real topic in its
  // `?topics=` filter and have it discarded with no error on either side.
  const tsPattern = extractTsPattern(authoritySrc);
  const goPattern = extractGoPattern(readOrRecord(GO_STREAM_HANDLER));
  if (!tsPattern) {
    errors.push(
      `${AUTHORITY}: missing \`export const EVENT_TOPIC_FILTER_PATTERN = "…"\` — ` +
        `the wire topic grammar must be declared once, here.`,
    );
  }
  if (!goPattern) {
    errors.push(
      `${GO_STREAM_HANDLER}: could not find \`streamTopicRE = regexp.MustCompile(\`…\`)\`.`,
    );
  }
  if (tsPattern && goPattern) {
    const unportable = [
      ...new Set([
        ...unportableEscapes(tsPattern),
        ...unportableEscapes(goPattern),
      ]),
    ];
    if (unportable.length > 0) {
      errors.push(
        `wire topic grammar uses escape(s) ${unportable.join(", ")} whose meaning ` +
          `DIFFERS between Go's RE2 and JavaScript (\\s, \\w and \\b are ` +
          `ASCII-only in RE2 and Unicode-aware in JS). Two byte-identical ` +
          `sources would then accept different inputs while this check passed. ` +
          `Express the class explicitly (e.g. [a-z0-9_-]) instead.`,
      );
    } else if (tsPattern !== goPattern) {
      errors.push(
        `wire topic grammar DRIFT between Go and TypeScript:\n` +
          `      ${GO_STREAM_HANDLER}: ${goPattern}\n` +
          `      ${AUTHORITY}:         ${tsPattern}\n` +
          `    A filter legal on one side and illegal on the other is dropped ` +
          `silently — the client asks, the server discards, nothing logs.`,
      );
    }
  }
  for (const file of TOPIC_NORMALIZERS) {
    const src = readOrRecord(file);
    if (!src) continue;
    if (!src.includes("isValidEventTopicFilter")) {
      errors.push(
        `${file}: must validate topics with \`isValidEventTopicFilter\` from ` +
          `@postwave/query-contract rather than a local grammar.`,
      );
    }
    if (/new RegExp\(|=\s*\/\^\(\\\*\|/.test(src)) {
      errors.push(
        `${file}: declares its own topic regex. The grammar lives in ` +
          `${AUTHORITY}; a private copy is how it drifted from the gateway.`,
      );
    }
  }

  return errors;
}

/**
 * Escapes whose meaning is IDENTICAL in Go's RE2 and in JavaScript's RegExp.
 *
 * A byte-for-byte comparison of two pattern sources only proves equivalence if
 * every construct means the same thing on both sides. Several do not: `\s`, `\w`
 * and `\b` are ASCII-only in RE2 but Unicode-aware in JS, so two identical
 * sources would silently accept different inputs and the drift check would pass
 * while the grammars disagreed. Rather than model those differences, the
 * comparison refuses to run on any pattern using them.
 */
const PORTABLE_ESCAPES = new Set([
  "\\*",
  "\\.",
  "\\(",
  "\\)",
  "\\[",
  "\\]",
  "\\{",
  "\\}",
  "\\$",
  "\\^",
  "\\|",
  "\\+",
  "\\?",
  "\\-",
  "\\/",
  "\\\\",
]);

/** Escape sequences in `pattern` that are not on the portable list. */
function unportableEscapes(pattern) {
  return [...pattern.matchAll(/\\[\s\S]/g)]
    .map((m) => m[0])
    .filter((e) => !PORTABLE_ESCAPES.has(e));
}

/** `EVENT_TOPIC_FILTER_PATTERN = "…"` → the unescaped regex source. */
function extractTsPattern(src) {
  const m =
    /EVENT_TOPIC_FILTER_PATTERN\s*(?::\s*string\s*)?=\s*"((?:\\.|[^"\\])*)"/.exec(
      src,
    );
  if (!m) return "";
  // Undo ONE level of JS string escaping so the value is the same regex source
  // Go's raw string holds literally. Only `\\` and `\"` are string-level
  // escapes; everything else (`\.`, `\*`, and any unportable `\s`) is a REGEX
  // escape that must survive verbatim so the comparison and the portability
  // check both see it.
  return m[1].replace(/\\(.)/g, (_all, ch) =>
    ch === "\\" || ch === '"' ? ch : `\\${ch}`,
  );
}

/** ``streamTopicRE = regexp.MustCompile(`…`)`` → the raw regex source. */
function extractGoPattern(src) {
  const m = /streamTopicRE\s*=\s*regexp\.MustCompile\(`([^`]*)`\)/.exec(src);
  return m ? m[1] : "";
}

// --- self-test ------------------------------------------------------------

const GRAMMAR =
  "^(\\\\*|[a-z][a-z0-9_-]*(\\\\.[a-z][a-z0-9_-]*)*(\\\\.\\\\*)?)$";

const VALID_AUTHORITY = `
export const CANONICAL_RESOURCES = ["a", "b"] as const;
export const EVENT_TOPIC_FILTER_PATTERN = "${GRAMMAR}";
export function canonicalResourcesForEvent(t) { return []; }
`;

const VALID_GO = [
  "var streamTopicRE = regexp.MustCompile(`",
  "^(\\*|[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)*(\\.\\*)?)$",
  "`)",
].join("");

const VALID_NORMALIZER = `
import { isValidEventTopicFilter } from "@postwave/query-contract";
export function normalizeEventBusTopics(topics) {
  return topics.filter(isValidEventTopicFilter).join(",");
}
`;

function clientSource({
  adapter,
  unbacked,
  entries,
  unbackedList,
  extra = "",
}) {
  const decl =
    unbackedList === null
      ? ""
      : `export const ${unbacked} = [${unbackedList
          .map((r) => `"${r}"`)
          .join(", ")}] as const;`;
  return `
import { canonicalResourcesForEvent, type CanonicalResource } from "@postwave/query-contract";
${extra}
const ${adapter}: Record<CanonicalResource, readonly string[]> = {
${entries}
};
${decl}
`;
}

/** A reader whose three client files share one shape; overrides by surface. */
function fakeRepo(overrides = {}) {
  const files = {
    [AUTHORITY]: overrides.authority ?? VALID_AUTHORITY,
    [GO_STREAM_HANDLER]: overrides.go ?? VALID_GO,
  };
  for (const f of TOPIC_NORMALIZERS) {
    files[f] = overrides.normalizer ?? VALID_NORMALIZER;
  }
  for (const c of CLIENTS) {
    const o = overrides[c.surface] ?? {};
    files[c.file] = clientSource({
      adapter: c.adapter,
      unbacked: c.unbacked,
      entries: o.entries ?? `  a: ["a"],\n  b: ["b"],`,
      unbackedList: o.unbackedList ?? null,
      extra: o.extra ?? "",
    });
  }
  return (p) => (p in files ? files[p] : null);
}

function selfTest() {
  const cases = [
    {
      name: "clean repo passes",
      read: fakeRepo(),
      expect: (errs) => errs.length === 0,
    },
    {
      name: "undeclared empty mapping is caught",
      read: fakeRepo({ mobile: { entries: `  a: ["a"],\n  b: [],` } }),
      expect: (errs) =>
        errs.some(
          (e) =>
            e.includes("mobile") && e.includes("MOBILE_UNBACKED_RESOURCES"),
        ),
    },
    {
      name: "declared empty mapping passes",
      read: fakeRepo({
        mobile: { entries: `  a: ["a"],\n  b: [],`, unbackedList: ["b"] },
      }),
      expect: (errs) => errs.length === 0,
    },
    {
      name: "partial declaration is caught",
      read: fakeRepo({
        web: { entries: `  a: [],\n  b: [],`, unbackedList: ["a"] },
      }),
      expect: (errs) =>
        errs.some((e) => e.includes("`b`") && e.includes("absent from")),
    },
    {
      name: "stale declaration is caught",
      read: fakeRepo({
        desktop: { entries: `  a: ["a"],\n  b: ["b"],`, unbackedList: ["b"] },
      }),
      expect: (errs) => errs.some((e) => e.includes("still lists")),
    },
    {
      name: "web resolver-function empty entry is caught",
      read: (p) =>
        p === AUTHORITY
          ? VALID_AUTHORITY
          : p === CLIENTS[0].file
            ? `
import { canonicalResourcesForEvent, type CanonicalResource } from "@postwave/query-contract";
const WEB_RESOURCE_KEYS: Record<CanonicalResource, (e) => unknown[]> = {
  a: (_e, t, r) => [base("a", t, r)],
  b: () => [],
};
`
            : fakeRepo()(p),
      expect: (errs) =>
        errs.some((e) => e.includes("web") && e.includes("`b`")),
    },
    {
      name: "untyped adapter is caught",
      read: (p) =>
        p === AUTHORITY
          ? VALID_AUTHORITY
          : p === CLIENTS[1].file
            ? `
import { canonicalResourcesForEvent } from "@postwave/query-contract";
const DESKTOP_RESOURCE_PREFIXES = { a: ["a"] };
`
            : fakeRepo()(p),
      expect: (errs) =>
        errs.some((e) => e.includes("Record<CanonicalResource")),
    },
    {
      name: "hard-coded topic table (no authority call) is caught",
      read: (p) =>
        p === AUTHORITY
          ? VALID_AUTHORITY
          : p === CLIENTS[2].file
            ? `const MOBILE_RESOURCE_ROOTS = { a: ["a"] };`
            : fakeRepo()(p),
      expect: (errs) =>
        errs.some((e) => e.includes("canonicalResourcesForEvent")),
    },
    {
      name: "missing authority export is caught",
      read: fakeRepo({ authority: `export const NOTHING = 1;` }),
      expect: (errs) =>
        errs.some((e) => e.includes("shared authority is incomplete")),
    },
    // --- empty-mapping bypasses an earlier revision of this checker missed ---
    {
      name: "bypass: empty array with an inline comment inside",
      read: fakeRepo({
        mobile: { entries: `  a: ["a"],\n  b: [/* nothing to invalidate */],` },
      }),
      expect: (errs) => errs.some((e) => e.includes("`b`")),
    },
    {
      name: "bypass: block-bodied arrow returning []",
      read: fakeRepo({
        web: { entries: `  a: ["a"],\n  b: () => { return []; },` },
      }),
      expect: (errs) => errs.some((e) => e.includes("`b`")),
    },
    {
      name: "bypass: async arrow returning []",
      read: fakeRepo({ web: { entries: `  a: ["a"],\n  b: async () => [],` } }),
      expect: (errs) => errs.some((e) => e.includes("`b`")),
    },
    {
      name: "bypass: indirection through an empty const",
      read: fakeRepo({
        desktop: {
          extra: `const EMPTY_KEYS: readonly string[] = [];`,
          entries: `  a: ["a"],\n  b: EMPTY_KEYS,`,
        },
      }),
      expect: (errs) => errs.some((e) => e.includes("`b`")),
    },
    {
      name: "bypass: empty array with an `as const` suffix",
      read: fakeRepo({ mobile: { entries: `  a: ["a"],\n  b: [] as const,` } }),
      expect: (errs) => errs.some((e) => e.includes("`b`")),
    },
    {
      name: "no false positive: a comment mentioning `b: []`",
      read: fakeRepo({
        desktop: {
          entries: `  a: ["a"],\n  // legacy shape was { keys, b: [] } before the refactor\n  b: ["b"],`,
        },
      }),
      expect: (errs) => errs.length === 0,
    },
    {
      name: "no false positive: a non-empty const indirection",
      read: fakeRepo({
        mobile: {
          extra: `const B_ROOTS: readonly string[] = ["b-root"];`,
          entries: `  a: ["a"],\n  b: B_ROOTS,`,
        },
      }),
      expect: (errs) => errs.length === 0,
    },
    // --- bypasses an enumerate-the-empty-spellings check let through --------
    ...[
      [
        "`satisfies` tail (this repo's own idiom)",
        `  b: [] satisfies readonly string[],`,
      ],
      ["quoted key", `  "b": [],`],
      ["Object.freeze", `  b: Object.freeze([]),`],
      ["spread of nothing", `  b: [...[]],`],
      ["new Array<T>()", `  b: new Array<string>(),`],
      ["[].concat()", `  b: [].concat(),`],
      ["parenthesised arrow body", `  b: () => ([]),`],
      ["block arrow via a local", `  b: () => { const o = []; return o; },`],
      ["`as const` on an empty literal", `  b: [] as const,`],
      ["empty const indirection", `  b: NO_ROOTS,`],
    ].map(([label, entry]) => ({
      name: `bypass: ${label}`,
      read: fakeRepo({
        desktop: {
          extra: `const NO_ROOTS: readonly string[] = [];`,
          entries: `  a: ["a"],\n${entry}`,
        },
      }),
      expect: (errs) => errs.some((e) => e.includes("`b`")),
    })),
    {
      name: "no false positive: a value containing a comment-like string",
      read: fakeRepo({
        mobile: { entries: `  a: ["https://x/y"],\n  b: ["b//c"],` },
      }),
      expect: (errs) => errs.length === 0,
    },
    {
      name: "no false positive: a nested value with an inner comma",
      read: fakeRepo({
        web: {
          entries: `  a: (_e, t, r) => [base("a", t, r)],\n  b: (_e, t, r) => [qk.b(t, r, "x")],`,
        },
      }),
      expect: (errs) => errs.length === 0,
    },
    // --- cross-language wire-grammar drift ---
    {
      name: "Go/TS topic grammar drift is caught",
      read: fakeRepo({
        go: [
          "var streamTopicRE = regexp.MustCompile(`",
          "^(\\*|[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*(\\.\\*)?)$",
          "`)",
        ].join(""),
      }),
      expect: (errs) =>
        errs.some((e) => e.includes("wire topic grammar DRIFT")),
    },
    {
      name: "missing EVENT_TOPIC_FILTER_PATTERN is caught",
      read: fakeRepo({
        authority: `
export const CANONICAL_RESOURCES = ["a", "b"] as const;
export function canonicalResourcesForEvent(t) { return []; }
`,
      }),
      expect: (errs) =>
        errs.some((e) => e.includes("EVENT_TOPIC_FILTER_PATTERN")),
    },
    {
      name: "an escape with different Go/JS semantics is refused, not compared",
      read: fakeRepo({
        authority: `
export const CANONICAL_RESOURCES = ["a", "b"] as const;
export const EVENT_TOPIC_FILTER_PATTERN = "^[a-z]\\\\s*$";
export function canonicalResourcesForEvent(t) { return []; }
`,
        go: "var streamTopicRE = regexp.MustCompile(`^[a-z]\\s*$`)",
      }),
      // Byte-identical sources, yet \s is ASCII-only in RE2 and Unicode-aware
      // in JS — so equality would be a FALSE pass. The check must refuse.
      expect: (errs) =>
        errs.some((e) => e.includes("DIFFERS between Go's RE2")),
    },
    {
      name: "a client re-declaring the topic regex is caught",
      read: fakeRepo({
        normalizer: `
const LOCAL_RE = /^(\\*|[a-z][a-z0-9-]*)$/;
export function normalizeEventBusTopics(t) { return t.filter((x) => LOCAL_RE.test(x)).join(","); }
`,
      }),
      expect: (errs) =>
        errs.some((e) => e.includes("isValidEventTopicFilter")) ||
        errs.some((e) => e.includes("declares its own topic regex")),
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const errs = runChecks(c.read);
    if (c.expect(errs)) {
      console.log(`  ✓ ${c.name}`);
    } else {
      failed += 1;
      console.error(
        `  ✗ ${c.name}\n      got: ${JSON.stringify(errs, null, 2)}`,
      );
    }
  }
  if (failed > 0) {
    console.error(`\n✗ event-map parity self-test: ${failed} case(s) failed.`);
    process.exit(1);
  }
  console.log(
    `\n✓ event-map parity self-test: ${cases.length}/${cases.length} cases pass.`,
  );
}

// --- entry point ----------------------------------------------------------

// Only act when executed directly. Importing this module (the self-test
// harness does, and so could a future test) must not run the repo-wide check
// or call process.exit as a side effect.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!invokedDirectly) {
  // Importer: expose runChecks only.
} else if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const errors = runChecks((relPath) => {
    try {
      return readFileSync(resolve(repoRoot, relPath), "utf8");
    } catch {
      return null;
    }
  });

  if (errors.length > 0) {
    console.error("✗ event-map parity check FAILED:\n");
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      "\nAll clients must route realtime events through the one shared\n" +
        "@postwave/query-contract authority (canonicalResourcesForEvent). See\n" +
        "packages/query-contract/src/events.ts.",
    );
    process.exit(1);
  }

  console.log(
    `✓ event-map parity: web + desktop + mobile all derive cache invalidation ` +
      `from @postwave/query-contract (${CLIENTS.length}/3 surfaces, ` +
      `Record<CanonicalResource> totality enforced, no undeclared empty mappings).`,
  );
}
