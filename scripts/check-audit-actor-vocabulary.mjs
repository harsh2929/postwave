#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// The audit filter offered two actor types the server never writes.
//
// `apps/web/.../settings/audit/page.tsx` once listed ["user", "api_key",
// "agent", "system"]. The database's canonical audit actor vocabulary is
// "human", "agent", "system", and "platform_operator". So filtering by
// "user" or "api_key"
// returned an empty page every time — which a person reads as "nothing
// happened", not as "that is not a category" — and "human", the DEFAULT actor
// type and the commonest value in the table, could not be filtered at all.
//
// Both halves are quiet failures. A filter that always returns nothing looks
// exactly like a clean audit log, and a missing option looks exactly like a
// category that does not exist.
//
// WHY A GUARD AND NOT JUST A FIX. The list is a hand-maintained copy of a
// vocabulary that lives in Go, in a different language, in a different app,
// edited by different people. That is the shape this repo keeps finding
// (`one rule with N hand-maintained copies`), and correcting the copy once does
// nothing about the next actor type somebody adds. This makes the Go source the
// authority and fails when the copy drifts.
//
// DERIVED, NOT LISTED. The vocabulary is extracted from the actual
// `middleware.WithActor(...)` call sites plus the documented API-key values,
// rather than from a second hand-written list here — a guard whose expectation
// is its own copy of the answer certifies the assumption instead of the code.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_PAGE = "apps/web/src/app/(dashboard)/app/settings/audit/page.tsx";
const GO_ROOTS = ["apps/api", "services"];

// A string literal passed as WithActor's actorType argument.
const WITH_ACTOR = /WithActor\(\s*\w+\s*,\s*"([a-z_]+)"/g;
// The fallback inside firstNonEmpty(x.ActorType, "agent") — the literal is the
// value used when the record carries none, so it is writable.
const WITH_ACTOR_FALLBACK = /WithActor\(\s*\w+\s*,\s*firstNonEmpty\([^,]+,\s*"([a-z_]+)"/g;
// A package constant used as the actor type, e.g. impersonate.ActorType.
const ACTOR_TYPE_CONST = /^const ActorType = "([a-z_]+)"/m;
// The documented API-key vocabulary: ActorType string // "human" | "agent"
const APIKEY_DOC = /ActorType\s+string[^\n]*\/\/\s*"([a-z_]+)"\s*\|\s*"([a-z_]+)"/;

function goFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "vendor") continue;
    const full = join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) goFiles(full, out);
    else if (entry.endsWith(".go") && !entry.endsWith("_test.go")) out.push(full);
  }
  return out;
}

export function vocabularyFrom(sources) {
  const found = new Map(); // value -> where
  const note = (value, where) => {
    if (!found.has(value)) found.set(value, where);
  };
  for (const { file, source } of sources) {
    for (const m of source.matchAll(WITH_ACTOR)) note(m[1], file);
    for (const m of source.matchAll(WITH_ACTOR_FALLBACK)) note(m[1], file);
    const constMatch = ACTOR_TYPE_CONST.exec(source);
    if (constMatch) note(constMatch[1], file);
    const docMatch = APIKEY_DOC.exec(source);
    if (docMatch) {
      note(docMatch[1], file);
      note(docMatch[2], file);
    }
    // The default the audit middleware falls back to when nothing set an actor.
    // Written as a bare assignment rather than through WithActor, so it needs
    // its own reader or the commonest value in the table stays invisible.
    const def = /actorType = "([a-z_]+)"/.exec(source);
    if (def) note(def[1], file);
  }
  return found;
}

export function listedInWeb(source) {
  const block = /const ACTOR_TYPES = \[([\s\S]*?)\] as const;/.exec(source);
  if (!block) return null;
  return new Set(
    [...block[1].matchAll(/"([a-z_]*)"/g)].map((m) => m[1]).filter((v) => v !== ""),
  );
}

function selfTest() {
  const cases = [
    {
      name: "reads a plain WithActor literal",
      run: () =>
        vocabularyFrom([{ file: "a.go", source: `middleware.WithActor(ctx, "system", "w")` }]).has(
          "system",
        ),
    },
    {
      name: "reads the firstNonEmpty fallback",
      run: () =>
        vocabularyFrom([
          { file: "b.go", source: `WithActor(ctx, firstNonEmpty(auth.ActorType, "agent"), lbl)` },
        ]).has("agent"),
    },
    {
      name: "reads a package ActorType constant",
      run: () =>
        vocabularyFrom([{ file: "c.go", source: `const ActorType = "platform_operator"\n` }]).has(
          "platform_operator",
        ),
    },
    {
      name: "reads the documented api-key pair",
      run: () => {
        const v = vocabularyFrom([
          { file: "d.go", source: `\tActorType            string     \`json:"actorType"\`            // "human" | "agent"` },
        ]);
        return v.has("human") && v.has("agent");
      },
    },
    {
      name: "reads the audit middleware default",
      run: () =>
        vocabularyFrom([{ file: "e.go", source: `\t\tactorType = "human"` }]).has("human"),
    },
    {
      name: "parses the web list and drops the empty option",
      run: () => {
        const set = listedInWeb(`const ACTOR_TYPES = ["", "human", "agent"] as const;`);
        return set.size === 2 && set.has("human") && !set.has("");
      },
    },
    {
      name: "an unparseable web list is null, not an empty set",
      run: () => listedInWeb("const OTHER = [];") === null,
    },
  ];
  let failed = 0;
  for (const c of cases) {
    let ok = false;
    try {
      ok = c.run();
    } catch (error) {
      console.error(`  self-test threw: ${error.message}`);
    }
    if (!ok) {
      failed += 1;
      console.error(`  FAIL ${c.name}`);
    }
  }
  if (failed > 0) {
    console.error(`check-audit-actor-vocabulary: ${failed} self-test(s) failed`);
    process.exit(1);
  }
  console.log(`check-audit-actor-vocabulary: ${cases.length} self-tests passed`);
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const files = GO_ROOTS.flatMap((root) => goFiles(join(repoRoot, root)));
  // A floor: scanning nothing yields an empty vocabulary, which would make every
  // web entry look unwritten and produce a confidently wrong failure.
  const MIN_GO_FILES = 500;
  if (files.length < MIN_GO_FILES) {
    console.error(
      `check-audit-actor-vocabulary: scanned only ${files.length} Go files, expected at least ` +
        `${MIN_GO_FILES}. Refusing to compare against a vocabulary this guard failed to read.`,
    );
    process.exit(1);
  }

  const written = vocabularyFrom(
    files.map((file) => ({ file: relative(repoRoot, file), source: readFileSync(file, "utf8") })),
  );
  const listed = listedInWeb(readFileSync(join(repoRoot, WEB_PAGE), "utf8"));
  if (listed === null) {
    console.error(
      `check-audit-actor-vocabulary: could not find the ACTOR_TYPES list in ${WEB_PAGE}. ` +
        `If it moved, point this guard at its new home — silently passing would leave the ` +
        `filter free to drift again.`,
    );
    process.exit(1);
  }

  let failures = 0;

  for (const [value, where] of written) {
    if (!listed.has(value)) {
      failures += 1;
      console.error(
        `check-audit-actor-vocabulary: the server writes actor_type ${JSON.stringify(value)} ` +
          `(${where}) and the audit filter does not offer it.\n` +
          `  Those rows exist and cannot be found by anyone using the filter. Add it to ` +
          `ACTOR_TYPES in ${WEB_PAGE}.`,
      );
    }
  }

  for (const value of listed) {
    if (!written.has(value)) {
      failures += 1;
      console.error(
        `check-audit-actor-vocabulary: the audit filter offers actor_type ${JSON.stringify(value)} ` +
          `and nothing writes it.\n` +
          `  That filter returns an empty page every time, which reads as "nothing happened" ` +
          `rather than "not a category". Remove it from ACTOR_TYPES in ${WEB_PAGE}, or find ` +
          `the writer this guard cannot see and teach it to the extractor.`,
      );
    }
  }

  if (failures > 0) {
    console.error(`check-audit-actor-vocabulary: ${failures} mismatch(es)`);
    process.exit(1);
  }

  console.log(
    `check-audit-actor-vocabulary: OK — ${written.size} actor type(s) written by the server, ` +
      `all offered by the audit filter.`,
  );
}

main();
