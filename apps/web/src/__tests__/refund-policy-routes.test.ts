// SPDX-License-Identifier: AGPL-3.0-only
//
// The refund policy is a binding commitment, so every route it tells a
// customer to take has to be one they can actually complete.
//
// It used to lead with "Dashboard: Settings → Billing → 'Request refund.'"
// Both halves were fiction: there is no "Request refund" affordance anywhere
// in the app, and Billing is a top-level section (/app/billing), not a child
// of Settings. A customer following the documented *primary* route reached a
// dead end, on the page that defines what we owe them.
//
// The assertions below are deliberately bidirectional: if someone later builds
// the dashboard control, the test says so instead of silently keeping the copy
// suppressed forever.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

/**
 * Source with comments stripped. Every assertion here is about what a customer
 * actually reads, and a `{/* … *​/}` note explaining why some copy was removed
 * would otherwise re-trip the very check it documents.
 */
function visibleCopy(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // JSX comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/^\s*\/\/.*$/gm, ""); // line comments
}

const POLICY = visibleCopy(join(SRC, "app/(marketing)/legal/refund/page.tsx"));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Files that make up the signed-in product surface. */
function appSurface(): string[] {
  return [
    ...walk(join(SRC, "app/(dashboard)")),
    ...walk(join(SRC, "components")),
  ];
}

describe("refund policy points at routes that exist", () => {
  it("reads the policy and the app surface", () => {
    // Guard the guard: a moved page or a broken walk must fail loudly rather
    // than let every assertion below pass against an empty string.
    expect(POLICY).toContain("refunds@moosewave.com");
    expect(appSurface().length).toBeGreaterThan(50);
  });

  it("only advertises a dashboard refund control if one is built", () => {
    const advertised = /request\s+refund/i.test(POLICY);
    const built = appSurface().some((f) => /request\s+refund/i.test(visibleCopy(f)));
    // Advertising it while it does not exist is the bug. Building it and
    // leaving the policy silent is a (smaller) miss worth surfacing too.
    expect({ advertised, built }).toEqual({
      advertised: built,
      built,
    });
  });

  it("does not file Billing under Settings", () => {
    // Billing is a sibling of Settings in the sidebar, not a child.
    const routes = readFileSync(join(SRC, "lib/dashboard-routes.ts"), "utf8");
    expect(routes).toContain('href: "/app/billing"');
    expect(routes).not.toContain('href: "/app/settings/billing"');

    const normalized = POLICY.replace(/&rarr;/g, "→").replace(/\s+/g, " ");
    expect(normalized).not.toMatch(/Settings\s*→\s*Billing/i);
  });
});
