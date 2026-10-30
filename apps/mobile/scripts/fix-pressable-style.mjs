#!/usr/bin/env node
/**
 * Codemod: NativeWind v4 silently drops the function form of `style` on
 * Pressable (`style={({ pressed }) => ({ … })}`), so any LAYOUT held in that
 * function (flexDirection/padding/border/etc.) never renders — lists and
 * cards collapse to flush, padding-less columns. Convert each to a static
 * object style, resolving `pressed ? A : B` ternaries to the non-pressed
 * branch (B). Press feedback is lost on iOS (acceptable; layout is the bug).
 *
 * Only the `=> ({ … })` object form is auto-converted; array/other forms are
 * reported for manual handling.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MARKER = "style={({ pressed }) => (";

// Walk app/ + src/components for .tsx files that contain the marker — no
// shell, so nothing is interpolated into a command string.
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = [...walk("app"), ...walk("src/components")].filter((f) =>
  readFileSync(f, "utf8").includes(MARKER),
);
let totalConverted = 0;
const manual = [];

function resolvePressedTernaries(body) {
  // pressed ? A : B  ->  B   (simple, comma/brace-terminated branches)
  let out = body;
  let prev;
  do {
    prev = out;
    out = out.replace(
      /pressed\s*\?\s*[^:?]+?\s*:\s*([^,}\n]+)/g,
      (_m, b) => b.trim(),
    );
  } while (out !== prev);
  return out;
}

for (const file of files) {
  let src = readFileSync(file, "utf8");
  let changed = false;
  let idx;
  while ((idx = src.indexOf(MARKER)) !== -1) {
    // After the marker we're positioned at the `{` of the returned object.
    const objStart = idx + MARKER.length; // points at "{"
    if (src[objStart] !== "{") {
      // Not the object form (e.g. `=> [` array) — leave for manual review.
      manual.push(`${file}: non-object form near index ${idx}`);
      // Advance past this marker so we don't loop forever.
      src =
        src.slice(0, idx) +
        src.slice(idx).replace(MARKER, "style={/*MANUAL*/(({ pressed }) => (");
      continue;
    }
    // Brace-match the object literal.
    let depth = 0;
    let i = objStart;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const objEnd = i; // index of the matching "}"
    // Expect ")}" right after to close the arrow-call and the JSX expression.
    const after = src.slice(objEnd + 1);
    const closeMatch = after.match(/^\s*\)\s*\}/);
    if (!closeMatch) {
      manual.push(`${file}: unexpected close near index ${objEnd}`);
      src =
        src.slice(0, idx) +
        src.slice(idx).replace(MARKER, "style={/*MANUAL*/(({ pressed }) => (");
      continue;
    }
    const objText = src.slice(objStart, objEnd + 1); // "{ ... }"
    const resolved = resolvePressedTernaries(objText);
    const replacement = `style={${resolved}}`;
    const fullEnd = objEnd + 1 + closeMatch[0].length;
    src = src.slice(0, idx) + replacement + src.slice(fullEnd);
    changed = true;
    totalConverted++;
  }
  // Restore any MANUAL markers we parked.
  src = src.replaceAll("style={/*MANUAL*/(({ pressed }) => (", MARKER);
  if (changed) writeFileSync(file, src);
}

console.log(`Converted ${totalConverted} function-style Pressables across ${files.length} files.`);
if (manual.length) {
  console.log(`\nNEEDS MANUAL REVIEW (${manual.length}):`);
  for (const m of manual) console.log("  - " + m);
}
