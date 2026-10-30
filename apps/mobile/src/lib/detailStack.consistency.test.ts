/**
 * Entity-detail navigation shape (LOVE-V#1).
 *
 * THE BUG THIS PINS. Every entity detail route — `campaigns/[id]`,
 * `subscribers/[id]`, `lists/[id]`, … — used to be a SIBLING
 * `<Tabs.Screen href={null}>` in `app/(tabs)/_layout.tsx`. A bottom-tab
 * navigator has no card presentation, so opening a record was a tab SWAP:
 *
 *   - no push transition (LOVE#7),
 *   - no interactive edge-swipe back — the most-used gesture on iOS,
 *   - no automatic back affordance, which is exactly why all ten screens
 *     hand-roll `<ScreenHeader onBack={() => goBackOr(…)}>`,
 *   - and nothing beneath the detail on a cold deep link, so
 *     `router.canGoBack()` was false and Back had to REPLACE with a guess
 *     (LOVE#48).
 *
 * The fix is structural: each family becomes a directory with its own
 * `_layout.tsx` rendering `<EntityDetailStack>`, so `index` and its details
 * share ONE push stack inside ONE tab. This test is the guard that keeps the
 * shape — a future screen dropped back into the tab group as a sibling would
 * silently lose the gesture again, and nothing else in the suite would notice.
 *
 * It is a TEXT scan, not an import: route modules pull in react-native and
 * expo-router, neither of which loads under the node vitest environment. The
 * RENDER behaviour of the layouts (that a Stack really is mounted, with the
 * header off and the gesture on) is pinned separately, in the jest-expo suite
 * at __tests__/detail-stack.native.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HIDDEN_TAB_SCREENS } from "./hiddenTabScreens";

const MOBILE_ROOT = process.cwd();
const TABS_ROOT = join(MOBILE_ROOT, "app", "(tabs)");

/**
 * Families converted to a push stack, with the detail routes each one owns.
 *
 * The list is written out rather than derived so that DELETING a `_layout.tsx`
 * fails here instead of quietly making the guard vacuous.
 */
const PUSH_STACK_FAMILIES: readonly { dir: string; details: string[] }[] = [
  { dir: "campaigns", details: ["[id].tsx", "[id]/ab-results.tsx"] },
  { dir: "subscribers", details: ["[id].tsx"] },
  { dir: "approvals", details: ["[id].tsx"] },
  { dir: "lists", details: ["[id].tsx"] },
  { dir: "segments", details: ["[id].tsx"] },
  { dir: "suppressions", details: ["[email].tsx"] },
];

/**
 * Families that still hold their detail route as a tab sibling.
 *
 * They are NOT an oversight and they are NOT a different problem — they are the
 * same conversion, blocked on one edit to `app/(tabs)/_layout.tsx`. Each of
 * these directories has no `<family>.tsx`, so Expo Router registers the folder
 * index as `sequences/index`, not `sequences`. The moment a `_layout.tsx` is
 * added the route node collapses to `sequences`, the layout's existing
 * `<Tabs.Screen name="sequences/index">` stops matching, and an UNREGISTERED
 * `sequences` screen leaks onto the bottom rail with the default ▽ icon — a
 * visible regression. So the layout rename has to land in the same change, and
 * that file is not ours to edit.
 *
 * Listing them keeps the remaining work in the code rather than in a note.
 */
const PENDING_FAMILIES: readonly { dir: string; blockedOn: string }[] = [
  {
    dir: "sequences",
    blockedOn: 'rename <Tabs.Screen name="sequences/index"> to "sequences"',
  },
  {
    dir: "forms",
    blockedOn: 'rename <Tabs.Screen name="forms/index"> to "forms"',
  },
  {
    dir: "sms",
    blockedOn:
      'collapse "sms/index" + "sms/[phone]" + "sms/suppressions" to one "sms"',
  },
];

/**
 * `<Tabs.Screen name="…">` entries that name a screen now owned by a nested
 * stack. Expo Router answers those with a `[Layout children]: No route named
 * "…"` warning and drops them, so they are inert — but they are dead text that
 * misdescribes the navigator, and removing them is a pending edit to the
 * orchestrator-owned tab layout.
 *
 * The assertion is a SUBSET check on purpose: a new stale entry fails, and
 * deleting these passes. It must never grow.
 */
const KNOWN_STALE_TAB_REGISTRATIONS = new Set([
  "campaigns/[id]",
  "campaigns/[id]/ab-results",
  "subscribers/[id]",
  "approvals/[id]",
  "lists/[id]",
  "segments/[id]",
  "suppressions/[email]",
]);

function read(...segments: string[]): string {
  return readFileSync(join(...segments), "utf8");
}

/**
 * Every name the tab navigator registers: the literals still written inline in
 * `_layout.tsx` UNION the data-module list it maps over.
 *
 * The bulk of the secondary routes moved to `lib/hiddenTabScreens.ts` when the
 * inline JSX pushed the layout past its line ceiling. Both halves are explicit
 * declarations, so scanning both preserves exactly what this guard proved
 * before: that a screen owned by a nested navigator is not ALSO named by the
 * tab layout (which is what produces Expo Router's "No route named …" warning).
 */
function tabScreenRegistrations(): string[] {
  return [
    ...Array.from(
      read(TABS_ROOT, "_layout.tsx").matchAll(/name="([^"]+)"/gu),
      (match) => match[1]!,
    ),
    ...HIDDEN_TAB_SCREENS.map(([name]) => name),
  ];
}

function directoryEntries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("entity detail routes live in a push stack", () => {
  it("finds the tab group (guards against a silently-empty scan)", () => {
    expect(statSync(TABS_ROOT).isDirectory()).toBe(true);
    expect(directoryEntries(TABS_ROOT).length).toBeGreaterThan(40);
  });

  it.each(PUSH_STACK_FAMILIES.map((family) => [family.dir, family] as const))(
    "%s is a directory navigator whose list and details share one stack",
    (dir, family) => {
      const familyRoot = join(TABS_ROOT, dir);

      // The list route moved INTO the directory. If `<dir>.tsx` came back,
      // Expo Router would have two modules claiming the same url.
      expect(existsSync(join(TABS_ROOT, `${dir}.tsx`))).toBe(false);
      expect(existsSync(join(familyRoot, "index.tsx"))).toBe(true);

      const layout = read(familyRoot, "_layout.tsx");
      expect(layout).toContain("EntityDetailStack");
      // Seeds the list beneath a cold-start detail so Back POPS rather than
      // replacing with a guessed fallback route.
      expect(layout).toContain(
        'export const unstable_settings = { initialRouteName: "index" };',
      );

      for (const detail of family.details) {
        expect(
          existsSync(join(familyRoot, detail)),
          `${dir}/${detail} should sit inside the ${dir} stack`,
        ).toBe(true);
      }
    },
  );

  it("registers each converted family as ONE tab screen, not one per record", () => {
    const registrations = tabScreenRegistrations();
    for (const family of PUSH_STACK_FAMILIES) {
      expect(
        registrations,
        `the tab layout must register the ${family.dir} navigator itself`,
      ).toContain(family.dir);
    }
  });

  it("never grows a new tab registration for a screen a nested stack owns", () => {
    const nestedDirs = new Set(PUSH_STACK_FAMILIES.map((f) => f.dir));
    const stale = tabScreenRegistrations().filter((name) => {
      const top = name.split("/")[0] ?? name;
      return nestedDirs.has(top) && name !== top;
    });
    const unexpected = stale.filter(
      (name) => !KNOWN_STALE_TAB_REGISTRATIONS.has(name),
    );
    expect(unexpected).toEqual([]);
  });

  it("keeps the still-pending families honest about what blocks them", () => {
    for (const family of PENDING_FAMILIES) {
      const familyRoot = join(TABS_ROOT, family.dir);
      expect(existsSync(familyRoot)).toBe(true);
      // The moment one of these grows a `_layout.tsx`, its entry belongs in
      // PUSH_STACK_FAMILIES instead — and the tab layout must be renamed in
      // the same change or the folder index leaks onto the rail.
      expect(
        existsSync(join(familyRoot, "_layout.tsx")),
        `${family.dir} was converted without ${family.blockedOn}`,
      ).toBe(false);
      expect(existsSync(join(familyRoot, "index.tsx"))).toBe(true);
    }
  });

  it("hides the native header and keeps the pop gesture on", () => {
    const stack = read(MOBILE_ROOT, "src/components/EntityDetailStack.tsx");
    // The native header would DOUBLE the in-body <ScreenHeader> every screen
    // already renders; the gesture is the entire point of the conversion.
    expect(stack).toMatch(/headerShown:\s*false/u);
    expect(stack).toMatch(/gestureEnabled:\s*true/u);
  });

  it("leaves every detail screen's back chevron on the history-aware helper", () => {
    // A Stack makes `router.canGoBack()` true where it was false, but the
    // helper is still what decides — a bare `router.back()` would strand a
    // user whose stack really is empty (an unseeded cold link).
    for (const family of PUSH_STACK_FAMILIES) {
      for (const detail of family.details) {
        const source = read(TABS_ROOT, family.dir, detail);
        if (!source.includes("onBack")) continue;
        expect(
          /goBackOr\b|goBackOrMore|router\.canGoBack\(/u.test(source),
          `${family.dir}/${detail} must route Back through a history-aware helper`,
        ).toBe(true);
      }
    }
  });
});
