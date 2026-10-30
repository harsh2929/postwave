/**
 * A mutation persisted across a restart must be able to RUN after it.
 *
 * WHY THIS EXISTS. Offline writes survive an app restart only if three things
 * agree, and nothing previously required them to:
 *
 *   1. `meta: offlineSafeMutationMeta` -- `shouldPersistMutation` writes only
 *      these to disk.
 *   2. a `mutationKey` -- a rehydrated mutation carries its variables but NOT
 *      its `mutationFn`, which is a closure and cannot be serialised.
 *   3. `setMutationDefaults` registered for that exact key -- this is the ONLY
 *      way the function comes back.
 *
 * Mark a write offlineSafe and forget the key, and the failure is silent and
 * maximally late: the operator makes an edit on a plane, the app is killed, and
 * on reconnect the mutation is restored as a ZOMBIE with no function to call.
 * It never runs and never errors. The edit is simply gone, having shown a
 * success toast hours earlier.
 *
 * Node-run: no react-native imports.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/u.test(p) && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const ROOT = join(__dirname, "..");
const SOURCES = walk(ROOT).filter((p) => !p.endsWith("queryClient.ts"));

/** Keys that have a mutationFn registered via setMutationDefaults. */
function registeredKeys(): Set<string> {
  const keys = new Set<string>();
  for (const f of [
    join(ROOT, "lib", "offlineMutations.ts"),
    join(ROOT, "lib", "offlineEntityWrite.ts"),
  ]) {
    for (const m of readFileSync(f, "utf8").matchAll(
      /setMutationDefaults\(\s*OFFLINE_MUTATION_KEYS\.(\w+)/gu,
    )) {
      keys.add(m[1]!);
    }
  }
  return keys;
}

/** Files declaring an offline-safe mutation, with the key they use. */
function offlineSafeSites(): { file: string; key: string | null }[] {
  const out: { file: string; key: string | null }[] = [];
  for (const f of SOURCES) {
    const src = readFileSync(f, "utf8");
    if (!/meta:\s*offlineSafeMutationMeta/u.test(src)) continue;
    const m = /mutationKey:\s*OFFLINE_MUTATION_KEYS\.(\w+)/u.exec(src);
    out.push({ file: f.slice(ROOT.length + 1), key: m?.[1] ?? null });
  }
  return out;
}

describe("offline write survivability", () => {
  it("finds the registrations and the call sites (guards an empty scan)", () => {
    expect(registeredKeys().size).toBeGreaterThan(2);
    expect(offlineSafeSites().length).toBeGreaterThan(2);
  });

  it("gives every persisted mutation a key whose mutationFn is registered", () => {
    const registered = registeredKeys();
    const broken = offlineSafeSites().filter(
      (s) => s.key === null || !registered.has(s.key),
    );
    expect(
      broken.map((s) => `${s.file} -> ${s.key ?? "NO mutationKey"}`),
      "these persist across a restart but have no registered mutationFn to resume with, so the queued write is restored as a zombie: it never runs, never errors, and the operator was already told it succeeded",
    ).toEqual([]);
  });
});
