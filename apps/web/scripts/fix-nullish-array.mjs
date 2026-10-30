/**
 * Replace `<wire> ?? []` with `Array.isArray(<wire>) ? <wire> : []` wherever the
 * result is ITERATED.
 *
 * WHY. `??` is a NULLISH guard: it catches null and undefined and nothing else.
 * A truthy non-array — `{}` from a dropped `omitempty` list, a paged
 * `{items: []}` envelope where a bare array was expected, an HTML SPA fallback
 * for an absent upstream — sails straight past it into `.map`/spread/for-of and
 * throws "is not a function" or "is not iterable".
 *
 * The identical sweep on apps/mobile hardened 71 sites and turned up 14 live
 * crashes, one of which rendered 1,293 phantom rows by reading `.length` off an
 * HTML document that had been typed as an array.
 *
 * Only rewrites expressions that look like WIRE data (data/rows/items/payload/
 * response/body/result) and are side-effect free, since the guard evaluates the
 * expression twice.
 *
 *   node scripts/fix-nullish-array.mjs [--apply]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const WIRE = /\b(?:data|rows|payload|response|body|items|result|list|entries)\b/i;

/** Evaluated twice by the guard, so it must be free of calls and assignment. */
function safeToRepeat(expr) {
  if (/[()]/.test(expr)) return false;
  if (/[=+\-*/%]|\+\+|--/.test(expr)) return false;
  if (/\bawait\b|\byield\b/.test(expr)) return false;
  return /^[\w$]+(?:(?:\?\.|\.)[\w$]+)*$/.test(expr.trim());
}

const SHAPES = [
  // const x = <wire> ?? []
  { re: /((?:const|let)\s+[\w$]+\s*(?::[^=]+?)?=\s*)([^;\n]*?)(\s*\?\?\s*\[\])/g, g: 2 },
  // (<wire> ?? []).map(...)
  { re: /\(\s*([^()]*?)\s*\?\?\s*\[\]\s*\)(?=\s*\.\s*(?:map|filter|forEach|reduce|slice|some|every|find|findIndex|sort|flatMap|join|includes|at)\()/g, g: 1, whole: true },
  // for (const x of (<wire> ?? []))
  { re: /(for\s*\(\s*const\s+[\w$]+\s+of\s*\(?\s*)([^()]*?)(\s*\?\?\s*\[\])/g, g: 2 },
  // [...(<wire> ?? [])]
  { re: /(\[\s*\.\.\.\s*\(?\s*)([^\]()]*?)(\s*\?\?\s*\[\])/g, g: 2 },
  // useMemo(() => <wire> ?? [], deps)  — the DOMINANT form, and the one a
  // naive "does the expression contain a paren?" safety check skips, because
  // the paren belongs to useMemo rather than to the expression being repeated.
  { re: /(=>\s*)([\w$]+(?:(?:\?\.|\.)[\w$]+)*)(\s*\?\?\s*\[\])/g, g: 2 },
  // prop={<wire> ?? []}
  { re: /([\w$]+=\{\s*)([^{}]*?)(\s*\?\?\s*\[\]\s*\})/g, g: 2 },
];

const files = globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
  .filter((f) => !f.includes(".test.") && !f.includes("__tests__"));

let changed = 0;
let sites = 0;
const skipped = [];

for (const file of files) {
  const before = readFileSync(file, "utf8");
  let after = before;

  for (const shape of SHAPES) {
    after = after.replace(shape.re, (match, ...rest) => {
      const groups = rest.slice(0, -2);
      const expr = (groups[shape.g - 1] ?? "").trim();
      if (!WIRE.test(expr)) return match;
      if (!safeToRepeat(expr)) {
        skipped.push(`${file}: ${expr}`);
        return match;
      }
      const guard = `Array.isArray(${expr}) ? ${expr} : []`;
      if (shape.whole) return `(${guard})`;
      const head = groups[shape.g - 2] ?? "";
      const tail = groups[shape.g] ?? "";
      // Keep whatever followed the `?? []` (a closing brace, etc).
      const trailer = tail.replace(/^\s*\?\?\s*\[\]/, "");
      return `${head}${guard}${trailer}`;
    });
  }

  if (after !== before) {
    sites += (before.match(/\?\?\s*\[\]/g) ?? []).length -
      (after.match(/\?\?\s*\[\]/g) ?? []).length;
    changed += 1;
    if (APPLY) writeFileSync(file, after);
  }
}

console.log(`${APPLY ? "rewrote" : "would rewrite"} ${sites} site(s) in ${changed} file(s)`);
if (skipped.length) {
  console.log(`skipped ${skipped.length} unsafe-to-repeat expression(s):`);
  for (const s of skipped.slice(0, 10)) console.log(`   ${s}`);
}
