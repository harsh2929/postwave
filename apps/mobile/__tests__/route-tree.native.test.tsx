/**
 * The route tree Expo Router actually builds (LOVE-V#1).
 *
 * The other two guards for this finding reason about FILES —
 * src/lib/detailStack.consistency.test.ts scans the directory shape,
 * __tests__/detail-stack.native.test.tsx renders the layout components. Neither
 * can answer the question that actually decides the behaviour: given this
 * `app/` directory, does the router build `campaigns` as a NAVIGATOR with the
 * list and the detail inside it, or as a flat pile of tab siblings?
 *
 * So this asks the router. `getRoutes` is the same function the app calls at
 * startup — the tree it returns here is the tree the device gets.
 *
 * What it pins:
 *
 *   1. Each converted family is ONE node with children. That is what makes the
 *      drill-down a push: the list and the detail are screens of the same
 *      stack, so opening a record slides in over a list that stays mounted and
 *      keeps its scroll offset, and the iOS edge-swipe pops back.
 *   2. `initialRouteName` is "index" on each of them, so a COLD deep link to a
 *      record builds [list, record] instead of [record] alone.
 *   3. The URL surface did not move. Every href the app can construct is still
 *      constructible — a directory rename that silently dropped /campaigns
 *      would break every deep link, push payload and web hand-off, and nothing
 *      else in the suite would catch it.
 *
 * It reaches into `expo-router/internal/testing` and `expo-router/build/…`
 * deliberately: those are the only entry points that build the tree without a
 * running Metro, and an SDK bump that moves them SHOULD fail here rather than
 * leave a guard that quietly stops guarding.
 */
import { describe, expect, it } from "@jest/globals";
import path from "node:path";

interface RouteNode {
  route: string;
  children?: RouteNode[];
  initialRouteName?: string;
}

/** Families whose list + detail share one push stack. */
const NESTED_FAMILIES: readonly (readonly [string, readonly string[]])[] = [
  ["campaigns", ["[id]", "index", "[id]/ab-results"]],
  ["subscribers", ["[id]", "index"]],
  ["approvals", ["[id]", "index"]],
  ["lists", ["[id]", "index"]],
  ["segments", ["[id]", "index"]],
  ["suppressions", ["[email]", "index"]],
];

/**
 * Families still registered flat on the tab rail. Converting one means adding
 * its `_layout.tsx` AND renaming its `<Tabs.Screen name="…/index">` entry in
 * the same change — the folder index would otherwise leak onto the bottom bar
 * with a default icon. Listing them keeps that pairing visible.
 */
const FLAT_FAMILIES: readonly (readonly [string, readonly string[]])[] = [
  ["sequences", ["sequences/[id]", "sequences/index"]],
  ["forms", ["forms/[id]", "forms/index"]],
  ["sms", ["sms/[phone]", "sms/broadcasts", "sms/index", "sms/suppressions"]],
];

function tabGroup(): RouteNode {
  process.env.EXPO_ROUTER_APP_ROOT = path.resolve(__dirname, "..", "app");
  const { requireContext } = require("expo-router/internal/testing") as {
    requireContext: (root: string, deep: boolean, ignore: RegExp) => unknown;
  };
  const { EXPO_ROUTER_CTX_IGNORE } = require("expo-router/_ctx-shared") as {
    EXPO_ROUTER_CTX_IGNORE: RegExp;
  };
  const { getRoutes } = require("expo-router/build/getRoutes") as {
    getRoutes: (ctx: unknown, options: object) => RouteNode;
  };
  const ctx = requireContext(
    process.env.EXPO_ROUTER_APP_ROOT,
    true,
    EXPO_ROUTER_CTX_IGNORE,
  );
  const root = getRoutes(ctx, { platform: "ios" });

  const find = (node: RouteNode | undefined, name: string): RouteNode | null => {
    for (const child of node?.children ?? []) {
      if (child.route === name) return child;
      const hit = find(child, name);
      if (hit) return hit;
    }
    return null;
  };
  const tabs = find(root, "(tabs)");
  if (!tabs) throw new Error("no (tabs) group in the route tree");
  return tabs;
}

describe("the route tree Expo Router builds", () => {
  const tabs = tabGroup();

  it("finds the tab group (guards against a silently-empty scan)", () => {
    expect(tabs.children?.length ?? 0).toBeGreaterThan(40);
  });

  it.each(NESTED_FAMILIES)(
    "%s is a navigator whose children are its list and its details",
    (family, expectedChildren) => {
      // ONE route node, not one node per record.
      const node = tabs.children?.find((child) => child.route === family);
      expect(node).toBeTruthy();
      expect((node?.children ?? []).map((child) => child.route).sort()).toEqual(
        [...expectedChildren].sort(),
      );
      // Puts the list beneath a cold-start detail so Back pops to it.
      expect(node?.initialRouteName).toBe("index");
    },
  );

  it.each(FLAT_FAMILIES)(
    "%s is still flat — converting it needs a tab-layout rename in the same change",
    (family, expectedSiblings) => {
      expect(tabs.children?.some((child) => child.route === family)).toBe(false);
      expect(
        (tabs.children ?? [])
          .map((child) => child.route)
          .filter((route) => route.startsWith(`${family}/`))
          .sort(),
      ).toEqual([...expectedSiblings].sort());
    },
  );

  it("keeps every entity url reachable at the same path", () => {
    const paths = new Set<string>();
    const walk = (node: RouteNode, prefix: string): void => {
      for (const child of node.children ?? []) {
        const segment = child.route.replace(/\((?:[^)]*)\)\/?/gu, "");
        const next = segment ? `${prefix}/${segment}` : prefix;
        if (child.children?.length) walk(child, next);
        else paths.add(next.replace(/\/index$/u, "") || "/");
      }
    };
    walk(tabs, "");

    const required = [
      "/campaigns",
      "/campaigns/[id]",
      "/campaigns/[id]/ab-results",
      "/subscribers",
      "/subscribers/[id]",
      "/approvals",
      "/approvals/[id]",
      "/lists",
      "/lists/[id]",
      "/segments",
      "/segments/[id]",
      "/suppressions",
      "/suppressions/[email]",
      "/sequences",
      "/sequences/[id]",
      "/forms",
      "/forms/[id]",
      "/sms",
      "/sms/[phone]",
    ];
    expect(required.filter((url) => !paths.has(url))).toEqual([]);
  });
});
