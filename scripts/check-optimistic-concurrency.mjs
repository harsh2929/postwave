#!/usr/bin/env node
//
// scripts/check-optimistic-concurrency.mjs
//
// Which mutable resources are protected from a lost update, and which are not —
// as a reviewed decision rather than an accident.
//
// The substrate exists: `apps/api/internal/httpcache` provides `ParseIfMatch`,
// `WritePreconditionRequired` (428) and `WritePreconditionFailed` (412), and
// six packages use it. But there are 219 PATCH/PUT routes, so the default for a
// mutable resource is "no protection", and nothing records whether that was
// decided or merely never considered.
//
// The failure this guards is quiet by nature. Two people edit the same campaign;
// the second save wins; nobody sees an error, and the first person's work is
// gone with no trace in any log. That is worse than a conflict error in exactly
// the way a silent drop is worse than a duplicate.
//
// This gate does NOT try to make every route conditional — that would be a
// breaking change to a live API, and for many resources (append-only counters,
// idempotent toggles) it would be pure friction. It requires each REGISTERED
// resource to declare `required` or `optional`, and for `optional` to carry a
// reason. A resource that reaches for `ParseIfMatch` and then ignores the
// result, or one that claims `required` without a 428 path, fails.
//
// Usage:
//   node scripts/check-optimistic-concurrency.mjs
//   node scripts/check-optimistic-concurrency.mjs --self-test

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/**
 * Resources whose concurrency posture is a decided matter.
 *
 * `required`    — an unconditional write is refused with 428. Use when a lost
 *                 update destroys authored work that cannot be reconstructed.
 * `optional`     — If-Match is honoured when sent, ignored when absent. The
 *                 code must still PARSE it and refuse a stale one with a 412.
 * `unprotected`  — no concurrency control at all: last writer wins, silently.
 *
 * The third posture exists because the register was otherwise a flattering
 * sample. Only resources that already happened to be protected could be listed,
 * so the document described the safe corner of the codebase and said nothing
 * about the rest — which is where the risk lives. `unprotected` needs a reason
 * AND a statement of what a lost update costs there, so the entry reads as a
 * decision someone can disagree with rather than an omission.
 */
const RESOURCES = [
  {
    id: "subscriber-account-link",
    file: "apps/api/internal/subscribers/account_link.go",
    handler: "SetAccount",
    posture: "required",
    why: "Links an external identity to a subscriber. A lost update silently re-points an account at the wrong person, and nothing downstream can tell.",
  },
  {
    id: "subscriber-channel-consents",
    file: "apps/api/internal/subscribers/channel_consents.go",
    handler: "SetChannelConsent",
    posture: "required",
    why: "Consent state. Overwriting a withdrawal with a stale grant is a compliance failure, not a merge conflict.",
  },
  {
    id: "campaign-update",
    file: "apps/api/internal/campaigns/handlers.go",
    handler: "Update",
    posture: "optional",
    // Deliberately recorded rather than silently true. Making it required is a
    // BREAKING change: every client that PATCHes without first holding an ETag
    // would start receiving 428, and apps/web/src/lib/campaigns-api.ts sends
    // the header only when it happens to have one cached. The client-side
    // degradation is fixed separately; flipping the server is a product call.
    why: "Requiring If-Match would 428 every existing client that PATCHes without a cached ETag. Recorded as a known lost-update surface pending a deliberate cutover, not as an oversight.",
  },
  {
    id: "campaign-template-lifecycle",
    file: "apps/api/internal/campaigntemplates/lifecycle.go",
    handler: "setArchived",
    posture: "required",
    // Uses `requireTemplateIfMatch`, a package-local mandatory variant that
    // hand-parses the header instead of calling httpcache.ParseIfMatch — see
    // MECHANISMS below.
    why: "Templates are authored content with concurrent editors; a lost update discards work nobody can recover.",
  },
  {
    id: "flowbuilder-update",
    file: "apps/api/internal/flowbuilder/flowbuilder.go",
    handler: "UpdateFlow",
    posture: "required",
    why: "Flows are authored programs. Every web write now carries the exact strong ETag captured with its list/detail representation, and the repository repeats the comparison atomically so two editors cannot silently erase one another.",
  },
];

/**
 * The recognised ways to implement optimistic concurrency. There are SIX.
 *
 * An earlier version of this comment said three, and listed `designRevisionETag`
 * as one of them. That was wrong twice over: `designRevisionETag` only WRITES
 * an ETag onto a GET response and its file never reads `If-Match` at all, so it
 * is not a concurrency mechanism — a resource registered against it would have
 * passed with zero protection. And three of the real implementations were
 * missing entirely.
 *
 * They still do not share one implementation, but the shared parser now keeps
 * weak validators and lists intact so exact-token callers reject them rather
 * than silently weakening RFC 7232 strong comparison. The package-local
 * helpers also reject those values and provide their own response mapping.
 * Naming every mechanism remains important: a new hand parser is a place wire
 * behaviour can diverge even when today's accepted values agree.
 */
const MECHANISMS = [
  { token: "httpcache.ParseIfMatch", name: "shared httpcache.ParseIfMatch (exact token; reports wildcard separately)" },
  { token: "httpcache.IfMatchFailed", name: "shared httpcache.IfMatchFailed" },
  { token: "requireTemplateIfMatch", name: "campaigntemplates requireTemplateIfMatch (strict)" },
  { token: "requireDiscoveryIfMatch", name: "campaigntemplates requireDiscoveryIfMatch (strict)" },
  { token: "hasExactTrackingIfMatch", name: "consent hasExactTrackingIfMatch" },
  { token: `r.Header.Get("If-Match")`, name: "inline header parse (tags)" },
];

/** Ways a handler can refuse a stale write. */
const REFUSAL_TOKENS = ["WritePreconditionFailed", "StatusPreconditionFailed"];
/** Ways a handler can refuse an UNCONDITIONAL write. */
const REQUIRE_TOKENS = ["WritePreconditionRequired", "StatusPreconditionRequired"];

/**
 * The body of `func (…) name(…)`, comments stripped.
 *
 * Brace-counting rather than a Go parser: this runs in Node beside the other
 * gates, and the alternative is a Go program in the middle of a JS check. It is
 * conservative — an unbalanced brace inside a string literal ends the body
 * early, which can only ever cause a FALSE FAILURE, never a false pass.
 */
function handlerBody(src, name) {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // Prefer the HTTP HANDLER. A repo method and its handler routinely share a
  // name (`(r *Repo) SetAccount` and `(d *Deps) SetAccount`), and matching the
  // first would read the repo's body — which is where the precondition is
  // ENFORCED, not where the header is parsed. The `w http.ResponseWriter`
  // signature identifies the handler unambiguously.
  const handlerRe = new RegExp(
    `func\\s+(\\([^)]*\\)\\s*)?${name}\\s*\\(\\s*w\\s+http\\.ResponseWriter`,
  );
  let m = handlerRe.exec(stripped);
  if (!m) {
    m = new RegExp(`func\\s+(\\([^)]*\\)\\s*)?${name}\\s*\\(`).exec(stripped);
  }
  if (!m) return null;
  const open = stripped.indexOf("{", m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < stripped.length; i += 1) {
    if (stripped[i] === "{") depth += 1;
    else if (stripped[i] === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(open, i + 1);
    }
  }
  return stripped.slice(open);
}

/**
 * A handler's body plus the bodies of same-file functions it calls.
 *
 * One level only. Deeper following would eventually reach the whole package and
 * reintroduce the sibling-route hole this scoping exists to close.
 */
function handlerScope(fileSrc, name) {
  const body = handlerBody(fileSrc, name);
  if (body === null) return null;
  let scope = body;
  const called = new Set();
  for (const m of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    called.add(m[1]);
  }
  for (const callee of called) {
    if (callee === name) continue;
    const calleeBody = handlerBody(fileSrc, callee);
    if (calleeBody !== null) scope += "\n" + calleeBody;
  }
  return scope;
}

const read = (rel) => {
  const abs = resolve(repoRoot, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf8");
};

export function checkConcurrency(fs) {
  const errors = [];
  const seen = new Set();

  for (const resource of RESOURCES) {
    if (seen.has(resource.id)) {
      errors.push(`duplicate resource id "${resource.id}"`);
      continue;
    }
    seen.add(resource.id);

    const fileSrc = fs.read(resource.file);
    if (fileSrc === null) {
      errors.push(
        `${resource.id}: ${resource.file} does not exist. A register entry ` +
          `pointing at a deleted file excuses nothing and hides the next gap.`,
      );
      continue;
    }

    // The HANDLER's body, not the whole file.
    //
    // A file-scoped grep passes an entirely unprotected route because a SIBLING
    // route in the same file is protected — a review demonstrated three such
    // constructions, and the shipped register already contained one
    // (campaigntemplates `RestoreRevision` has no precondition, while
    // `setArchived` in the same file does). It also passed on a file whose only
    // mention of a mechanism was a comment saying the route did NOT use it.
    // The handler's body PLUS the bodies of the same-file helpers it calls.
    //
    // Handler-only was too narrow in the other direction: a handler typically
    // PARSES the header and delegates the refusal — `SetChannelConsent` writes
    // its 412 through `writeChannelConsentErr`, and `requireTemplateIfMatch`
    // emits both statuses itself. Following one level of delegation is the
    // level at which the property is actually implemented, while still refusing
    // to credit an unrelated sibling route.
    const src = handlerScope(fileSrc, resource.handler);
    if (src === null) {
      errors.push(
        `${resource.id}: no handler named "${resource.handler}" in ` +
          `${resource.file}. The register names a function so the check reads ` +
          `THAT route rather than whichever sibling happens to be protected.`,
      );
      continue;
    }

    const mechanism = MECHANISMS.find((m) => src.includes(m.token));
    const has412 = REFUSAL_TOKENS.some((t) => src.includes(t));
    const has428 = REQUIRE_TOKENS.some((t) => src.includes(t));

    if (resource.posture === "unprotected") {
      if (!resource.why) {
        errors.push(
          `${resource.id} is "unprotected" with no reason. That posture is the ` +
            `one that most needs an argument attached to it.`,
        );
      }
      if (mechanism) {
        errors.push(
          `${resource.id} is registered "unprotected" but ${resource.handler} ` +
            `uses ${mechanism.name}. The register is stale in the SAFE ` +
            `direction, which is still stale: a reader would under-trust a ` +
            `resource that is in fact guarded.`,
        );
      }
      continue;
    }

    if (!mechanism) {
      errors.push(
        `${resource.id} (${resource.file}) is registered as "${resource.posture}" ` +
          `but uses none of the recognised concurrency mechanisms ` +
          `(${MECHANISMS.map((m) => m.token).join(", ")}), so a stale write is ` +
          `accepted silently. Two editors, second one wins, no error and no log ` +
          `line. If it uses a FOURTH mechanism, add it to MECHANISMS — a rule ` +
          `with four implementations is worth seeing.`,
      );
      continue;
    }
    if (!has412) {
      errors.push(
        `${resource.id} uses ${mechanism.name} but never refuses a stale write ` +
          `(no 412). Reading the header and then not acting on it is worse than ` +
          `ignoring it: the caller believes it has concurrency control.`,
      );
    }
    if (resource.posture === "required" && !has428) {
      errors.push(
        `${resource.id} is registered "required" but has no 428 path ` +
          `(httpcache.WritePreconditionRequired). "Required" means an ` +
          `unconditional write is REFUSED; without it the posture is optional ` +
          `with a stricter comment.`,
      );
    }
    if (resource.posture === "optional" && !resource.why) {
      errors.push(
        `${resource.id} is "optional" with no reason. An unprotected mutable ` +
          `resource needs a decision on the record, not a default.`,
      );
    }
    if (resource.posture === "optional" && has428) {
      errors.push(
        `${resource.id} is registered "optional" but refuses unconditional ` +
          `writes with a 428. The register and the code disagree about whether ` +
          `callers may omit the header.`,
      );
    }
  }

  return errors;
}

// --- self-test --------------------------------------------------------------

function fakeFs(files) {
  return { read: (rel) => files[rel] ?? null };
}

// Fixtures are Go SOURCE now, because the check reads a handler's body rather
// than the whole file. That is the point: a bare token soup would pass a
// file-grep and must not pass this.
const handlerSrc = (name, body) =>
  `func (d *Deps) ${name}(w http.ResponseWriter, r *http.Request) {\n\t${body}\n}\n`;
const FULL = handlerSrc("H", "httpcache.ParseIfMatch(r); httpcache.WritePreconditionFailed(w); httpcache.WritePreconditionRequired(w)");
const ALT_FULL = handlerSrc("H", "requireTemplateIfMatch(w, r); httpcache.WritePreconditionFailed(w); httpcache.WritePreconditionRequired(w)");
const OPTIONAL_SRC = handlerSrc("H", "httpcache.ParseIfMatch(r); httpcache.WritePreconditionFailed(w)");
/** A protected route beside an unprotected one — the sibling-route hole. */
const SIBLING = FULL + handlerSrc("Unprotected", "doTheWrite()");


function baseFiles(over = {}) {
  const files = {};
  for (const r of RESOURCES) {
    // An `unprotected` fixture must have NO mechanism — otherwise it exercises
    // the stale-label branch instead of the happy path.
    const src =
      r.posture === "required"
        ? FULL
        : r.posture === "optional"
          ? OPTIONAL_SRC
          : handlerSrc("H", "doTheWrite()");
    files[r.file] = src.replace(/\bH\b/, r.handler);
  }
  return { ...files, ...over };
}

function selfTest() {
  const cases = [
    {
      name: "a register matching the code passes",
      fs: fakeFs(baseFiles()),
      expect: (e) => e.length === 0,
    },
    {
      name: "a resource with no concurrency mechanism at all is caught",
      fs: fakeFs(baseFiles({ [RESOURCES[0].file]: handlerSrc(RESOURCES[0].handler, "doTheWrite()") })),
      expect: (e) => e.some((x) => x.includes("none of the recognised concurrency mechanisms")),
    },
    {
      name: "parsing the header and ignoring it is caught",
      fs: fakeFs(baseFiles({ [RESOURCES[0].file]: handlerSrc(RESOURCES[0].handler, "httpcache.ParseIfMatch(r)") })),
      expect: (e) => e.some((x) => x.includes("never refuses a stale write")),
    },
    {
      name: "a `required` resource with no 428 path is caught",
      fs: fakeFs(baseFiles({ [RESOURCES[0].file]: OPTIONAL_SRC.replace(/\bH\b/, RESOURCES[0].handler) })),
      expect: (e) => e.some((x) => x.includes('registered "required" but has no 428')),
    },
    {
      name: "an `optional` resource that actually refuses is caught",
      fs: fakeFs(baseFiles({ [RESOURCES[2].file]: FULL.replace(/\bH\b/, RESOURCES[2].handler) })),
      expect: (e) => e.some((x) => x.includes('registered "optional" but refuses')),
    },
    {
      name: "a DIFFERENT recognised mechanism is accepted, not reported as unprotected",
      fs: fakeFs(baseFiles({ [RESOURCES[0].file]: ALT_FULL.replace(/\bH\b/, RESOURCES[0].handler) })),
      expect: (e) => e.length === 0,
    },
    {
      name: "an unrecognised mechanism is caught, naming the fourth-implementation risk",
      fs: fakeFs(baseFiles({ [RESOURCES[0].file]: handlerSrc(RESOURCES[0].handler, "myOwnIfMatchParser(r); httpcache.WritePreconditionFailed(w); httpcache.WritePreconditionRequired(w)") })),
      expect: (e) => e.some((x) => x.includes("none of the recognised concurrency mechanisms")),
    },
    {
      name: "an unprotected route does NOT pass on a protected sibling in the same file",
      fs: fakeFs(
        baseFiles({
          [RESOURCES[0].file]:
            FULL.replace(/\bH\b/, "SomeOtherRoute") +
            handlerSrc(RESOURCES[0].handler, "doTheWrite()"),
        }),
      ),
      expect: (e) => e.some((x) => x.includes("none of the recognised concurrency mechanisms")),
    },
    {
      name: "a register entry pointing at a deleted file is caught",
      fs: fakeFs(baseFiles({ [RESOURCES[1].file]: undefined })),
      expect: (e) => e.some((x) => x.includes("does not exist")),
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const errors = checkConcurrency(c.fs);
    if (c.expect(errors)) console.log(`  ✓ ${c.name}`);
    else {
      failed += 1;
      console.error(`  ✗ ${c.name}\n      got: ${JSON.stringify(errors, null, 2)}`);
    }
  }
  if (failed > 0) {
    console.error(`\n✗ optimistic-concurrency self-test: ${failed} case(s) failed.`);
    process.exit(1);
  }
  console.log(`\n✓ optimistic-concurrency self-test: ${cases.length}/${cases.length} cases pass.`);
}

// --- entry point ------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const errors = checkConcurrency({ read });
    if (errors.length > 0) {
      console.error("✗ optimistic concurrency check FAILED:\n");
      for (const e of errors) console.error(`  - ${e}`);
      console.error(
        `\nA lost update leaves no error and no log line. It is the quiet\n` +
          `class of failure, which is why the posture has to be recorded\n` +
          `rather than inferred from whichever helper a handler happened to call.`,
      );
      process.exit(1);
    }
    const count = (p) => RESOURCES.filter((r) => r.posture === p).length;
    console.log(
      `✓ optimistic concurrency: ${RESOURCES.length} registered resources ` +
        `(${count("required")} required, ${count("optional")} optional, ` +
        `${count("unprotected")} explicitly unprotected — each with a reason).\n` +
        `  Scope: only registered resources. The API has 219 PATCH/PUT routes; ` +
        `this does not claim the rest are safe, only that these were decided.`,
    );
  }
}
