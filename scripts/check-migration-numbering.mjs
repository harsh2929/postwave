#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Two migrations sharing one number is a collision that looks like nothing.
//
// `infra/migrations/` holds 1839_email_verification.sql AND
// 1839_landing_page_variants.sql. Both apply, the database ends up correct, and
// nothing anywhere complains — which is exactly why it went unnoticed for the
// six days between them being written.
//
// IT WORKS BY ACCIDENT, NOT BY DESIGN. The runner sorts by filename, so the
// order between the two is decided by `e` sorting before `l` in
// "email_verification" and "landing_page_variants". That is deterministic, and
// it is not intentional. Two authors each believed they owned 1839; had their
// migrations touched the same object, which one won would have been settled by
// alphabetical luck. The failure mode is not "the collision breaks the run", it
// is "the collision silently decides an ordering nobody chose".
//
// It also breaks how people talk about migrations. Every review comment,
// changelog line and incident note in this repo refers to migrations by number
// — "gated behind 1902", "widened in 1881". "Migration 1839" names two
// different things, so one of those references is always wrong.
//
// THE EXISTING PAIR IS NOT RENUMBERED, and that is a deliberate decision rather
// than an omission. `schema_migrations` records the applied version as the
// filename stem, so renaming a shipped migration makes the runner see an
// unknown new file and apply it again; the old ledger row cannot attest the new
// stem. That can duplicate data or fail DDL in every environment that already
// ran it. The pair stays; the guard stops the NEXT one.
//
// ENUMERATED, NOT COUNTED, for the reason the rest of this repo's guards are:
// a stored total ("1 known duplicate") silently absorbs the second collision,
// while a named list fails the moment an unlisted one appears.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "infra", "migrations");

// The one collision that already shipped. Listed with its reason so that
// removing it is a decision rather than a cleanup: these two files are recorded
// in real databases under these exact version strings.
const KNOWN_DUPLICATE_NUMBERS = new Map([
  [
    "1839",
    {
      files: ["1839_email_verification.sql", "1839_landing_page_variants.sql"],
      reason:
        "Both shipped and are recorded in schema_migrations under these stems; " +
        "renumbering either would present the runner with a new file to apply " +
        "again while the old ledger row remains bound to the original stem.",
    },
  ],
]);

// A migration filename is exactly four digits, then _<snake_case>.sql. The
// runner derives the applied version from the stem, so a name it cannot parse is
// not a style problem — it is a version string nobody can reason about.
//
// THE WIDTH IS FIXED AT FOUR, and that is the rule rather than a convention,
// because a variable width makes this guard defeatable. With `\d+`, "194_x.sql"
// and the shipped "0194_inbound_route_v2.sql" are two different numbers, so a
// second migration on 194 passes cleanly — the exact collision the guard exists
// to catch, walking straight through it. A review demonstrated this by dropping
// a probe file next to 0194. All 850 migrations in the tree are four digits, so
// the rule costs nothing and removes the ambiguity outright.
//
// (At 10000 migrations this needs revisiting. That is 9000 away, and a loud
// failure then is preferable to a silent hole now.)
const FILENAME_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

// Belt and braces for the same hazard: even if the width rule is ever relaxed,
// grouping on the zero-stripped number keeps 0194 and 194 in one bucket rather
// than two. Verified against the tree: stripping leading zeros produces no
// collision that did not already exist.
function canonicalNumber(digits) {
  return digits.replace(/^0+(?=\d)/, "");
}

export function inspect(filenames) {
  const byNumber = new Map();
  const malformed = [];

  for (const name of filenames) {
    const match = FILENAME_PATTERN.exec(name);
    if (!match) {
      malformed.push(name);
      continue;
    }
    const number = canonicalNumber(match[1]);
    if (!byNumber.has(number)) byNumber.set(number, []);
    byNumber.get(number).push(name);
  }

  const duplicates = [];
  for (const [number, files] of byNumber) {
    if (files.length < 2) continue;
    const sorted = [...files].sort();
    const known = KNOWN_DUPLICATE_NUMBERS.get(number);
    // A known collision is only tolerated while it is the SAME collision. A
    // third file joining 1839 is a new defect wearing an old exemption.
    const isKnown =
      known !== undefined &&
      known.files.length === sorted.length &&
      known.files.every((file, index) => file === sorted[index]);
    duplicates.push({ number, files: sorted, known: isKnown });
  }

  // A listed exception can drift in two opposite directions, and reporting them
  // with one message was wrong: a THIRD file joining 1839 produced "the recorded
  // exception no longer matches, remove the entry" — advice that would delete
  // the guard's own knowledge of a real collision in response to that collision
  // getting worse. The two cases are now distinguished, because the correct
  // action is opposite in each: shrunk means retire the entry, grown means the
  // new file must be renumbered.
  const staleExceptions = [];
  const grownExceptions = [];
  for (const [number, entry] of KNOWN_DUPLICATE_NUMBERS) {
    const sorted = [...(byNumber.get(number) ?? [])].sort();
    const expected = new Set(entry.files);
    const unexpected = sorted.filter((file) => !expected.has(file));
    const missing = entry.files.filter((file) => !sorted.includes(file));

    if (unexpected.length > 0) {
      grownExceptions.push({ number, expected: entry.files, unexpected });
    }
    // Only stale when the recorded pair is no longer a collision at all. A
    // grown collision still contains it, so it is not stale.
    if (unexpected.length === 0 && (missing.length > 0 || sorted.length < 2)) {
      staleExceptions.push({ number, expected: entry.files, found: sorted });
    }
  }

  return {
    total: filenames.length,
    malformed: malformed.sort(),
    duplicates: duplicates.sort((a, b) => a.number.localeCompare(b.number)),
    staleExceptions,
    grownExceptions,
  };
}

function selfTest() {
  const cases = [
    {
      name: "clean set passes",
      input: ["0001_a.sql", "0002_b.sql"],
      expect: (r) => r.duplicates.length === 0 && r.malformed.length === 0,
    },
    {
      name: "an unlisted duplicate is reported and not known",
      input: ["0001_a.sql", "0001_b.sql"],
      expect: (r) => r.duplicates.length === 1 && r.duplicates[0].known === false,
    },
    {
      name: "the shipped 1839 pair is recognised as known",
      input: ["1839_email_verification.sql", "1839_landing_page_variants.sql"],
      expect: (r) => r.duplicates.length === 1 && r.duplicates[0].known === true,
    },
    {
      name: "a THIRD file on a known number is not covered by the exemption",
      input: [
        "1839_email_verification.sql",
        "1839_landing_page_variants.sql",
        "1839_sneaks_in.sql",
      ],
      expect: (r) => r.duplicates.length === 1 && r.duplicates[0].known === false,
    },
    {
      name: "a grown exception is reported as grown, NOT as stale",
      input: [
        "1839_email_verification.sql",
        "1839_landing_page_variants.sql",
        "1839_sneaks_in.sql",
      ],
      expect: (r) =>
        r.grownExceptions.length === 1 &&
        r.grownExceptions[0].unexpected.length === 1 &&
        r.grownExceptions[0].unexpected[0] === "1839_sneaks_in.sql" &&
        r.staleExceptions.length === 0,
    },
    {
      name: "a known number that no longer collides is a stale exception",
      input: ["1839_email_verification.sql"],
      expect: (r) => r.staleExceptions.length === 1 && r.grownExceptions.length === 0,
    },
    {
      name: "malformed names are reported",
      input: ["not-a-migration.sql", "1234-dashes.sql", "1234_Caps.sql"],
      expect: (r) => r.malformed.length === 3,
    },
    {
      // Regression test for the hole a review walked through: with a variable
      // -width pattern, a probe named 194_x.sql sat beside the shipped
      // 0194_inbound_route_v2.sql as a DIFFERENT number and passed clean.
      name: "a short number is malformed, so it cannot dodge the collision check",
      input: ["0194_inbound_route_v2.sql", "194_probe.sql"],
      expect: (r) => r.malformed.length === 1 && r.malformed[0] === "194_probe.sql",
    },
    {
      name: "zero-stripped numbers share a bucket if the width rule is relaxed",
      input: ["0839_a.sql", "0839_b.sql"],
      expect: (r) => r.duplicates.length === 1,
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    let ok = false;
    try {
      ok = testCase.expect(inspect(testCase.input));
    } catch (error) {
      ok = false;
      console.error(`  self-test threw: ${error.message}`);
    }
    if (!ok) {
      failed += 1;
      console.error(`  FAIL ${testCase.name}`);
    }
  }
  if (failed > 0) {
    console.error(`check-migration-numbering: ${failed} self-test(s) failed`);
    process.exit(1);
  }
  console.log(`check-migration-numbering: ${cases.length} self-tests passed`);
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const filenames = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));

  // A floor, because an empty or mis-resolved directory would otherwise report
  // a clean result — the same "green over nothing" failure this guard exists to
  // prevent elsewhere.
  const MIN_MIGRATIONS = 800;
  if (filenames.length < MIN_MIGRATIONS) {
    console.error(
      `check-migration-numbering: found only ${filenames.length} migrations in ${migrationsDir}; ` +
        `expected at least ${MIN_MIGRATIONS}. Refusing to report a clean result over a directory ` +
        `this guard probably failed to read.`,
    );
    process.exit(1);
  }

  const report = inspect(filenames);
  let failures = 0;

  for (const entry of report.malformed) {
    failures += 1;
    console.error(
      `check-migration-numbering: ${entry} is not <4 digits>_<snake_case>.sql. The runner derives ` +
        `the applied version from this stem, so a name it cannot parse is a version nobody can ` +
        `reference. The width is fixed at four on purpose: with a variable width, "194_x.sql" and ` +
        `the shipped "0194_inbound_route_v2.sql" count as different numbers, and a real collision ` +
        `passes this check unnoticed.`,
    );
  }

  for (const duplicate of report.duplicates) {
    if (duplicate.known) continue;
    failures += 1;
    console.error(
      `check-migration-numbering: migration number ${duplicate.number} is used by ` +
        `${duplicate.files.length} files:\n` +
        duplicate.files.map((file) => `    ${file}`).join("\n") +
        `\n  Pick the next unused number. Two files on one number apply in filename order, ` +
        `which is deterministic but arbitrary: if they touch the same object, alphabetical luck ` +
        `decides which wins. It also makes "migration ${duplicate.number}" ambiguous in every ` +
        `review comment and incident note.`,
    );
  }

  for (const grown of report.grownExceptions) {
    failures += 1;
    console.error(
      `check-migration-numbering: migration number ${grown.number} is a RECORDED collision that ` +
        `has GROWN. Beyond the two files it is allowed to have ` +
        `(${JSON.stringify(grown.expected)}), it now also has:\n` +
        grown.unexpected.map((file) => `    ${file}`).join("\n") +
        `\n  Renumber the new file. The exemption covers exactly the pair that already shipped ` +
        `and cannot be recorded in schema_migrations any other way; it is not a licence to keep ` +
        `adding to that number. Do NOT widen the entry to make this pass.`,
    );
  }

  for (const stale of report.staleExceptions) {
    failures += 1;
    console.error(
      `check-migration-numbering: the recorded exception for ${stale.number} no longer describes ` +
        `a collision (expected ${JSON.stringify(stale.expected)}, found ` +
        `${JSON.stringify(stale.found)}). Remove the entry from KNOWN_DUPLICATE_NUMBERS so it ` +
        `stops exempting a collision that is not there.`,
    );
  }

  if (failures > 0) {
    console.error(`check-migration-numbering: ${failures} problem(s) across ${report.total} migrations`);
    process.exit(1);
  }

  const knownCount = report.duplicates.filter((entry) => entry.known).length;
  console.log(
    `check-migration-numbering: OK — ${report.total} migrations, unique numbering ` +
      `(${knownCount} recorded pre-existing collision${knownCount === 1 ? "" : "s"}).`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
