/**
 * A screen's HEADER is a claim about its behaviour. This checks one class of
 * claim against the implementation: if a header states the screen is
 * owner/admin, an actual gate must exist.
 *
 * WHY THIS CLASS. A screen whose reads are all ScopeAdmin, shown to a viewer,
 * renders 403s on every request -- a broken screen with no explanation, which
 * is the same family of lie as an error rendering as an empty state. The header
 * is where that intent is written down, and nothing checked it.
 *
 * WHY IT READS ALL THREE REGISTRIES. Route rows live in mobileRoutesCore.ts,
 * mobileRoutesAdmin.ts AND mobileRoutesTools.ts. Auditing this by hand against
 * two of the three produced twelve false positives -- send-time is gated in
 * core, inbound-routes in tools -- and would have "fixed" screens that were
 * already correct. A partial registry read is worse than none, because it
 * reports confidently.
 *
 * The claim pattern is deliberately narrow: a line beginning ROLE or
 * "WHY IT IS ADMIN". Headers routinely say things like "the PATCH is
 * ScopeAdmin" while the SCREEN is viewer, and matching that would flag every
 * screen that documents its writes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP_ROOT = join(__dirname, "..", "..");

function screenFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) screenFiles(full, out);
    else if (entry.endsWith(".tsx") && entry !== "_layout.tsx") out.push(full);
  }
  return out;
}

/** key -> whether the row carries minimumRole: "admin", across ALL registries. */
function adminGatedKeys(): Map<string, boolean> {
  const map = new Map<string, boolean>();
  const libDir = join(APP_ROOT, "src", "lib");
  for (const name of readdirSync(libDir)) {
    if (!/^mobileRoutes\w*\.ts$/u.test(name) || name.includes(".test.")) continue;
    const src = readFileSync(join(libDir, name), "utf8");
    const rowRe = /key:\s*"([^"]+)"([\s\S]{0,400}?)\n {2}\}/gu;
    for (const m of src.matchAll(rowRe)) {
      const key = m[1];
      const block = m[2] ?? "";
      if (key) map.set(key, /minimumRole:\s*"admin"/u.test(block));
    }
  }
  return map;
}

describe("a screen that claims to be admin-only is actually gated", () => {
  const registries = adminGatedKeys();

  it("reads every route registry, not a subset", () => {
    // Vacuity floor. Reading two of three files is what produced twelve false
    // positives by hand; an empty or partial map would pass every check below.
    expect(registries.size).toBeGreaterThan(50);
    expect([...registries.values()].filter(Boolean).length).toBeGreaterThan(5);
  });

  it("every whole-screen admin claim has a gate", () => {
    const appDir = join(APP_ROOT, "app");
    expect(existsSync(appDir)).toBe(true);
    const offenders: string[] = [];
    let claims = 0;

    for (const file of screenFiles(appDir)) {
      const raw = readFileSync(file, "utf8");
      const header = /^\s*\/\*\*([\s\S]*?)\*\//u.exec(raw);
      if (!header) continue;
      const head = header[1] ?? "";
      // A whole-screen role statement, not a note about one write.
      if (!/^\s*\*?\s*(ROLE|WHY IT IS ADMIN)\b.*\b(owner\/admin|admin)\b/imu.test(head)) {
        continue;
      }
      claims += 1;
      const key = file.split("/").pop()?.replace(".tsx", "") ?? "";
      const body = raw.slice(header[0].length).replace(/\/\*[\s\S]*?\*\//gu, "");
      const gated =
        registries.get(key) === true ||
        /canAccessMinimumRole|effectiveRole/u.test(body);
      if (!gated) offenders.push(file.replace(APP_ROOT, ""));
    }

    // Second floor: if no header matches, the check proves nothing.
    expect(claims).toBeGreaterThan(3);
    expect(
      offenders,
      "these screens tell the reader they are admin-only but nothing enforces it, " +
        "so a viewer reaches them and every request 403s",
    ).toEqual([]);
  });
});
