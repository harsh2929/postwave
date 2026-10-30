#!/usr/bin/env node
//
// scripts/check-sdk-tiers.mjs
//
// Enforces packages/openapi/sdk-manifest.json — the single declarative source
// of the Moosewave SDK surface — against the packages/sdk-* tree. Before the
// manifest, the two-tier reality (3 full SDKs: ts/py/php; 6 resource stubs:
// go/ruby/rust/java/dotnet/elixir) was smeared across check-sdk-parity.mjs,
// npm-release-plan.mjs and a stale parity-matrix.md, and the 6 stubs were
// entirely unguarded — free to silently rot (a resource disappears) or
// half-grow (a resource is added with no conscious tier decision).
//
// This guard asserts:
//   1. Manifest ↔ disk: every packages/sdk-* dir is declared, and every
//      declared dir exists (no phantom, no undeclared SDK).
//   2. Tier integrity: tier ∈ {full,stub}; the set of full SDKs equals
//      fullTier.members; exactly one canonical SDK; canonical is full.
//   3. Publish metadata: every SDK has its declared version/publish manifest
//      file (package.json / pyproject.toml / go.mod / …).
//   4. Stub surface (the drift guard): each stub's ACTUAL resource files equal
//      its DECLARED resources — no more, no less. Growing or shrinking a stub
//      now requires a conscious manifest edit (which is the tier decision).
//   5. Stub claim honesty: every stub README explicitly discloses its tier,
//      limited endpoint coverage, and lack of a generic request client.
//
// Full-tier method + error-taxonomy parity (ts↔py↔php) stays in
// check-sdk-parity.mjs; this owns the boundary + the stub surface. Exit
// non-zero on any breach.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const packagesDir = resolve(repoRoot, "packages");
const MANIFEST = resolve(packagesDir, "openapi/sdk-manifest.json");

const SKIP_DIRS = new Set([
  "node_modules", "target", "build", "bin", "obj", "dist",
  "_build", "deps", ".git", "vendor", "coverage",
]);

const errors = [];

function loadManifest() {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (!Array.isArray(m.sdks) || !m.fullTier || !Array.isArray(m.fullTier.members)) {
    throw new Error("sdk-manifest.json must have sdks[] and fullTier.members[]");
  }
  return m;
}

/** Recursively collect files with `ext` under `dir`, skipping build/vcs dirs. */
function collectFiles(dir, ext) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(join(dir, entry.name), ext));
    } else if (entry.isFile() && extname(entry.name) === ext) {
      out.push(entry.name);
    }
  }
  return out;
}

/** A test/spec file basename we never count as a resource. */
function isTestFile(name) {
  const lower = name.toLowerCase();
  return (
    lower.includes("_test.") ||
    lower.includes(".test.") ||
    lower.includes("_spec.") ||
    lower.includes(".spec.") ||
    lower.endsWith("test" + extname(name)) ||
    lower.startsWith("test")
  );
}

const manifest = loadManifest();

// --- 1. manifest ↔ disk -----------------------------------------------------
const onDisk = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("sdk-"))
  .map((e) => e.name)
  .sort();
const declared = manifest.sdks.map((s) => s.dir).sort();

for (const dir of onDisk) {
  if (!declared.includes(dir)) {
    errors.push(`packages/${dir} exists on disk but is NOT declared in sdk-manifest.json (undeclared SDK).`);
  }
}
for (const dir of declared) {
  if (!onDisk.includes(dir)) {
    errors.push(`sdk-manifest.json declares ${dir} but packages/${dir} does not exist (phantom).`);
  }
}

// --- 2. tier integrity ------------------------------------------------------
const fullOnDisk = manifest.sdks.filter((s) => s.tier === "full").map((s) => s.dir).sort();
const fullDeclared = [...manifest.fullTier.members].sort();
if (JSON.stringify(fullOnDisk) !== JSON.stringify(fullDeclared)) {
  errors.push(
    `fullTier.members ${JSON.stringify(fullDeclared)} disagrees with the SDKs marked tier:"full" ${JSON.stringify(fullOnDisk)}.`,
  );
}
const canonical = manifest.sdks.filter((s) => s.canonical);
if (canonical.length !== 1) {
  errors.push(`exactly one SDK must be canonical:true; found ${canonical.length}.`);
} else if (canonical[0].tier !== "full") {
  errors.push(`the canonical SDK (${canonical[0].dir}) must be tier:"full".`);
}
for (const s of manifest.sdks) {
  if (s.tier !== "full" && s.tier !== "stub") {
    errors.push(`${s.dir}: tier must be "full" or "stub", got ${JSON.stringify(s.tier)}.`);
  }
}

// --- 3. publish metadata ----------------------------------------------------
for (const s of manifest.sdks) {
  if (!s.manifestFile) {
    errors.push(`${s.dir}: missing manifestFile (version/publish source).`);
    continue;
  }
  if (!existsSync(resolve(packagesDir, s.dir, s.manifestFile))) {
    errors.push(`${s.dir}: declared manifestFile ${s.manifestFile} not found on disk.`);
  }
}

// --- 4. stub surface drift guard -------------------------------------------
for (const s of manifest.sdks) {
  if (s.tier !== "stub") continue;
  if (!Array.isArray(s.resources) || !s.resourceDir || !s.resourceExt) {
    errors.push(`${s.dir}: stub must declare resources[], resourceDir, resourceExt.`);
    continue;
  }
  const nonResource = new Set(s.nonResourceFiles ?? []);
  const scanDir = resolve(packagesDir, s.dir, s.resourceDir);
  const actual = collectFiles(scanDir, s.resourceExt)
    .filter((f) => !nonResource.has(f) && !isTestFile(f))
    .map((f) => basename(f, s.resourceExt).toLowerCase())
    .sort();
  const declaredRes = [...s.resources].map((r) => r.toLowerCase()).sort();

  const missing = declaredRes.filter((r) => !actual.includes(r));
  const extra = actual.filter((r) => !declaredRes.includes(r));
  if (missing.length) {
    errors.push(`${s.dir}: declared resource(s) missing from disk (rot): ${missing.join(", ")}.`);
  }
  if (extra.length) {
    errors.push(
      `${s.dir}: resource file(s) on disk not declared in the manifest (half-grow): ${extra.join(", ")}. ` +
        `Add them to sdk-manifest.json (a conscious tier decision) or exclude non-resource files via nonResourceFiles.`,
    );
  }
}

// --- 5. stub README claim guard ---------------------------------------------
const STUB_README_CLAIMS = [
  { pattern: /\bstub-tier client\b/i, description: 'the term "stub-tier client"' },
  {
    pattern: /does not provide full OpenAPI endpoint coverage or a generic\s+API request client/i,
    description: "the lack of full endpoint coverage and a generic API request client",
  },
];

for (const s of manifest.sdks) {
  if (s.tier !== "stub") continue;
  const readmePath = resolve(packagesDir, s.dir, "README.md");
  if (!existsSync(readmePath)) {
    errors.push(`${s.dir}: stub must have a README.md with an honest tier disclosure.`);
    continue;
  }
  // Ignore Markdown blockquote prefixes while preserving the user-visible text.
  const readme = readFileSync(readmePath, "utf8").replace(/^>\s?/gmu, "");
  for (const claim of STUB_README_CLAIMS) {
    if (!claim.pattern.test(readme)) {
      errors.push(`${s.dir}/README.md: stub disclosure must state ${claim.description}.`);
    }
  }
}

if (errors.length > 0) {
  console.error("✗ SDK tier check FAILED:\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error("\nSee packages/openapi/sdk-manifest.json (the declarative SDK surface).");
  process.exit(1);
}

const fullCount = manifest.sdks.filter((s) => s.tier === "full").length;
const stubCount = manifest.sdks.filter((s) => s.tier === "stub").length;
console.log(
  `✓ SDK tiers: ${manifest.sdks.length} SDKs declared & on disk ` +
    `(${fullCount} full, ${stubCount} stub); every stub's resource surface matches ` +
    `its declaration and README tier disclosure; publish metadata present for all.`,
);
