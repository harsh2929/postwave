/**
 * SHELL#70 — the app-lifecycle entry points must not stack the back stack.
 *
 * Deep links, the deferred-link flush, the Siri/App-Intent destination, the
 * share-extension inbox and notification taps every one called
 * `router.push()` unconditionally. Nothing checked whether the target was the
 * screen already on top, so tapping three notifications about the SAME
 * campaign stacked three identical screens and the user then pressed back
 * three times to escape.
 *
 * The decision now lives in `lib/navigateTo` (pure, unit-tested in
 * navigateTo.test.ts) behind `useNavigateToHref`. This file is the ratchet
 * that keeps a future edit from reintroducing a raw push in exactly the four
 * places a user cannot see coming — it reads the SOURCE rather than rendering,
 * because these hooks transitively import expo-notifications and
 * react-native, which cannot be loaded in the node test environment (house
 * rule 6).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every hook that turns an OUTSIDE-THE-APP event into a navigation. A screen
 * is deliberately not on this list: a tap on a row the user can see is an
 * explicit act, and pushing is right there.
 */
const LIFECYCLE_ROUTING_HOOKS = [
  "src/hooks/useDeepLinkRouting.ts",
  "src/hooks/usePushResponseRouting.ts",
  "src/hooks/useSharedInboxRouting.ts",
] as const;

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("shell navigation never stacks a duplicate screen", () => {
  it.each(LIFECYCLE_ROUTING_HOOKS)("%s routes through useNavigateToHref", (path) => {
    const source = read(path);
    expect(source).toContain("useNavigateToHref");
  });

  it.each(LIFECYCLE_ROUTING_HOOKS)("%s calls no bare router.push", (path) => {
    const source = read(path);
    // `router.replace` is fine — that IS the collapsed case. Only an
    // unconditional push is the bug.
    expect(source).not.toMatch(/\brouter\s*\.\s*push\s*\(/u);
  });

  it("keeps the navigate callback stable so it is safe as an effect dependency", () => {
    // A callback whose identity changed on every navigation would tear down
    // and re-subscribe the Linking / Notifications listeners after every route
    // change, and re-run the one-shot deferred-link flush. The stability comes
    // from reading the path through a ref rather than closing over it.
    const source = read("src/hooks/useNavigateTo.ts");
    expect(source).toContain("pathnameRef");
    expect(source).toMatch(/useCallback\([\s\S]*?\}, \[\]\)/u);
  });

  it("lists the navigate callback in each hook's effect dependencies", () => {
    // Listing it is only safe BECAUSE of the test above; pinning both together
    // is what stops one of them being "fixed" by dropping the dependency.
    for (const path of LIFECYCLE_ROUTING_HOOKS) {
      expect(read(path)).toMatch(/\[[^\]]*\bnavigate\b[^\]]*\]/u);
    }
  });
});
