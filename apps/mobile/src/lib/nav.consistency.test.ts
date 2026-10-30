/**
 * Nav consistency — the mobile app's primary navigation (bottom-tab bar +
 * the More-menu rows) must stay a SUBSET of the canonical @postwave/nav
 * manifest, and every manifest entry the manifest says mobile exposes must
 * actually be reachable from the app.
 *
 * The 2026-06-21 ecosystem audit found three surfaces hand-rolled three
 * divergent nav maps that disagreed on labels and orphaned shipped pages.
 * @postwave/nav is now the single source of truth. This test is the guard
 * that keeps the mobile nav from drifting away from it again:
 *
 *   - tabs/_layout.tsx declares the 5 bottom tabs (Home/People/Send/Approve
 *     + the More menu),
 *   - more.tsx declares the secondary destinations in a sectioned list.
 *
 * The two collections below MIRROR those files. They are deliberately
 * duplicated here (not imported) because the layout/menu modules pull in
 * react-native + expo-router, which don't import under the node test env;
 * the value of the test is precisely that it FAILS when the app's nav and
 * the manifest drift, forcing whoever changes one to reconcile the other.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  NAV_ENTRIES,
  navForSurface,
  routeFor,
  shortLabelFor,
} from "@postwave/nav";
import { mobilePath } from "@postwave/route-map";
import appConfig from "../../app.json";
import { HIDDEN_TAB_SCREENS } from "./hiddenTabScreens";
import {
  canAccessMobileCapability,
  canAccessMobileSecondaryRoute,
  MOBILE_CAPABILITIES,
  MOBILE_SECONDARY_ROUTES,
  mobileSecondaryRouteForPath,
  normalizeMobileAccessRole,
} from "./mobileRouteManifest";

/**
 * The bottom-tab destinations the app surfaces, by manifest key, with the
 * route + short (tab-bar) label the app renders. Mirrors
 * apps/mobile/app/(tabs)/_layout.tsx. "More" is a menu launcher, not a
 * manifest concept, so it is intentionally excluded.
 */
const MOBILE_TABS: readonly {
  key: string;
  route: string;
  tabLabel: string;
}[] = [
  { key: "dashboard", route: "/(tabs)/dashboard", tabLabel: "Home" },
  { key: "subscribers", route: "/(tabs)/subscribers", tabLabel: "People" },
  { key: "campaigns", route: "/(tabs)/campaigns", tabLabel: "Send" },
  { key: "approvals", route: "/(tabs)/approvals", tabLabel: "Approve" },
];

/**
 * The More-menu rows that correspond to a manifest nav concept, by manifest
 * key. Generated from the secondary-route manifest used by
 * apps/mobile/app/(tabs)/more.tsx so adding a secondary destination forces
 * route-file/nav/deep-link review in one place.
 */
const MOBILE_MORE_ROWS: readonly { key: string; route: string }[] =
  MOBILE_SECONDARY_ROUTES.filter((route) => route.navKey).map((route) => ({
    key: route.navKey!,
    route: route.route,
  }));

const MANIFEST_KEYS = new Set(NAV_ENTRIES.map((e) => e.key));
const TABS_ROOT = "app/(tabs)";
const TABS_LAYOUT_FILE = `${TABS_ROOT}/_layout.tsx`;

/**
 * Expo Router resolves `app/(tabs)/lists.tsx` and `app/(tabs)/lists/index.tsx`
 * to the SAME url — `/lists`. Families that own a detail route were converted
 * to the second shape (LOVE-V#1) so the list and its detail can share a push
 * stack; nothing about the url, the deep link, or the manifest entry changed.
 *
 * So this resolver accepts either spelling. It is NOT a loosening: the question
 * the assertion asks — "does a real route module back this manifest row?" — is
 * answered identically by both, and a manifest row pointing at neither still
 * fails.
 */
function resolveRouteFile(routeFile: string): string | null {
  const direct = join(process.cwd(), routeFile);
  if (existsSync(direct)) return direct;
  const asDirectoryIndex = join(
    process.cwd(),
    routeFile.replace(/\.tsx$/u, "/index.tsx"),
  );
  return existsSync(asDirectoryIndex) ? asDirectoryIndex : null;
}

/**
 * Tab-group subdirectories that own a `_layout.tsx` — i.e. that are a NESTED
 * NAVIGATOR rather than a bag of sibling tab screens.
 *
 * This is the structural fact the two registration assertions below turn on.
 * Expo Router collapses such a directory into ONE route node named after the
 * directory (`campaigns`), and the screens inside it (`index`, `[id]`,
 * `[id]/ab-results`) are registered by the nested layout — the TAB layout must
 * not, and cannot, name them.
 */
const NESTED_STACK_DIRS = new Set(
  readdirSync(join(process.cwd(), TABS_ROOT), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(process.cwd(), TABS_ROOT, entry.name, "_layout.tsx")),
    )
    .map((entry) => entry.name),
);

const PRIMARY_TAB_ROUTE_FILES = MOBILE_TABS.map((tab) => {
  const base = `${TABS_ROOT}/${tab.route.replace("/(tabs)/", "")}`;
  return NESTED_STACK_DIRS.has(tab.route.replace("/(tabs)/", ""))
    ? `${base}/index.tsx`
    : `${base}.tsx`;
});
const DETAIL_ROUTE_FILES = [
  `${TABS_ROOT}/campaigns/[id].tsx`,
  `${TABS_ROOT}/subscribers/[id].tsx`,
  `${TABS_ROOT}/sequences/[id].tsx`,
  `${TABS_ROOT}/forms/[id].tsx`,
  // Approval detail: reached from the queue and from an approval push.
  `${TABS_ROOT}/approvals/[id].tsx`,
  // SMS conversation thread: reached from the inbox list.
  `${TABS_ROOT}/sms/[phone].tsx`,
  // Helpdesk conversation thread: reached from the helpdesk queue.
  `${TABS_ROOT}/helpdesk/[id].tsx`,
  // Suppression detail: reached from the suppressions list.
  `${TABS_ROOT}/suppressions/[email].tsx`,
  `${TABS_ROOT}/campaigns/[id]/ab-results.tsx`,
  // Audience drill-downs: reached from the lists catalogue and the segments
  // catalogue respectively, not from the nav manifest.
  `${TABS_ROOT}/lists/[id].tsx`,
  `${TABS_ROOT}/segments/[id].tsx`,
  // Reached only by scanning a `login --device` QR (see lib/qr.ts + scan.tsx),
  // not a nav-manifest destination.
  `${TABS_ROOT}/cli-approve.tsx`,
];
/**
 * The nested navigators themselves. A `_layout.tsx` is not a destination — it
 * is the thing that registers the destinations under it — so it is accounted
 * for here rather than in the nav manifest.
 */
const NESTED_STACK_LAYOUT_FILES = [...NESTED_STACK_DIRS].map(
  (dir) => `${TABS_ROOT}/${dir}/_layout.tsx`,
);
const SPECIAL_TAB_ROUTE_FILES = [
  TABS_LAYOUT_FILE,
  `${TABS_ROOT}/more.tsx`,
  // Internal role-denial destination: intentionally absent from the product
  // nav manifest and reachable only through SecondaryRouteGuard.replace().
  `${TABS_ROOT}/access-denied.tsx`,
  ...NESTED_STACK_LAYOUT_FILES,
  ...DETAIL_ROUTE_FILES,
];

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function collectTabRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      out.push(...collectTabRouteFiles(abs));
    } else if (entry.endsWith(".tsx")) {
      out.push(toPosixPath(relative(process.cwd(), abs)));
    }
  }
  return out.sort();
}

/**
 * The `<Tabs.Screen name="…">` literal that must exist in the TAB layout for a
 * given tab-group route file.
 *
 * For a flat file that is the path minus extension (`settings`, `sms/index`).
 * For a file inside a nested navigator it is the DIRECTORY (`campaigns`) — the
 * screens below it belong to `campaigns/_layout.tsx`, and naming them here
 * would be an error Expo Router warns about at runtime
 * (`[Layout children]: No route named …`).
 */
/**
 * The `<Tabs.Screen name="…">` literals written inline in the tab layout.
 *
 * Since the bulk of the secondary routes moved to `lib/hiddenTabScreens.ts`,
 * what remains inline is the five bottom tabs plus the four folder-index detail
 * screens that take `SHELL` options rather than `hidden(...)`.
 */
function layoutScreenNameLiterals(): string[] {
  return Array.from(
    readFileSync(join(process.cwd(), TABS_LAYOUT_FILE), "utf8").matchAll(
      /name="([^"]+)"/g,
    ),
    (match) => match[1] as string,
  );
}

/**
 * Everything the tab navigator ends up registering: the inline literals UNION
 * the data-module list the layout maps over. Both halves are explicit
 * declarations — the property this guard protects is that no route file is
 * left to Expo Router's auto-registration, which would leak it into the tab bar
 * with a default ▽ icon — so reading both is the same check, not a weaker one.
 */
function registeredScreenNames(): Set<string> {
  return new Set([
    ...layoutScreenNameLiterals(),
    ...HIDDEN_TAB_SCREENS.map(([name]) => name),
  ]);
}

function screenNameForRouteFile(routeFile: string): string {
  const routePath = routeFile
    .replace(`${TABS_ROOT}/`, "")
    .replace(/\.tsx$/u, "");
  const top = routePath.split("/")[0] ?? routePath;
  return NESTED_STACK_DIRS.has(top) ? top : routePath;
}

describe("mobile nav ⊆ @postwave/nav manifest", () => {
  it("every bottom-tab entry is a manifest key the manifest exposes on mobile", () => {
    for (const tab of MOBILE_TABS) {
      expect(MANIFEST_KEYS.has(tab.key)).toBe(true);
      // Manifest must agree the entry is exposed on mobile (non-null route).
      expect(routeFor(tab.key, "mobile")).toBe(tab.route);
    }
  });

  it("every More-menu manifest row is a manifest key exposed on mobile", () => {
    for (const row of MOBILE_MORE_ROWS) {
      expect(MANIFEST_KEYS.has(row.key)).toBe(true);
      expect(routeFor(row.key, "mobile")).toBe(row.route);
    }
  });

  it("tab-bar short labels match the manifest's canonical shortLabel", () => {
    for (const tab of MOBILE_TABS) {
      expect(shortLabelFor(tab.key)).toBe(tab.tabLabel);
    }
  });

  it("the app reaches EVERY manifest entry exposed on mobile (no orphans)", () => {
    const reachable = new Set<string>([
      ...MOBILE_TABS.map((t) => t.key),
      ...MOBILE_MORE_ROWS.map((r) => r.key),
    ]);
    const manifestMobileKeys = navForSurface("mobile").map((e) => e.key);
    for (const key of manifestMobileKeys) {
      expect(reachable.has(key)).toBe(true);
    }
  });

  it("every secondary route has a backing route file", () => {
    for (const route of MOBILE_SECONDARY_ROUTES) {
      expect(
        resolveRouteFile(route.routeFile) !== null,
        `${route.key} should exist at ${route.routeFile} (or its directory-index form)`,
      ).toBe(true);
    }
  });

  it("every tab-group route file is accounted for by primary, More, or detail navigation", () => {
    const known = new Set([
      ...PRIMARY_TAB_ROUTE_FILES,
      ...MOBILE_SECONDARY_ROUTES.map(
        (route) =>
          // A manifest row may still name the pre-restructure `lists.tsx`
          // spelling; resolve it to whichever module actually backs the url.
          toPosixPath(
            relative(process.cwd(), resolveRouteFile(route.routeFile) ?? ""),
          ) || route.routeFile,
      ),
      ...SPECIAL_TAB_ROUTE_FILES,
    ]);
    for (const routeFile of collectTabRouteFiles(
      join(process.cwd(), TABS_ROOT),
    )) {
      expect(
        known.has(routeFile),
        `${routeFile} must be represented in the nav manifest or listed as a detail/special route`,
      ).toBe(true);
    }
  });

  it("every tab-group route file is explicitly registered in the tab layout", () => {
    const registered = registeredScreenNames();
    // Vacuity floor: a regex that stops matching (or a data module that stops
    // exporting) would make this loop pass by proving nothing.
    expect(registered.size).toBeGreaterThan(40);
    for (const routeFile of collectTabRouteFiles(
      join(process.cwd(), TABS_ROOT),
    )) {
      if (routeFile === TABS_LAYOUT_FILE) continue;
      expect(
        registered.has(screenNameForRouteFile(routeFile)),
        `${routeFile} must be registered — either as a <Tabs.Screen name="..."> literal in the tab layout or as an entry in lib/hiddenTabScreens.ts`,
      ).toBe(true);
    }
  });

  /**
   * The reverse direction, which the old single-source shape could not express.
   *
   * When registration was 110 lines of JSX, a stale entry was invisible: it
   * named a screen that no longer existed and nothing complained. Now that the
   * list is data, a name with no route file behind it is a detectable defect —
   * and it matters, because Expo Router warns at runtime for a `Tabs.Screen`
   * that names nothing ("No route named …"), which is a warning nobody reads.
   */
  it("every hidden-screen entry names a route file that actually exists", () => {
    const routeNames = new Set(
      collectTabRouteFiles(join(process.cwd(), TABS_ROOT))
        .filter((file) => file !== TABS_LAYOUT_FILE)
        .map(screenNameForRouteFile),
    );
    expect(HIDDEN_TAB_SCREENS.length).toBeGreaterThan(40);
    for (const [name] of HIDDEN_TAB_SCREENS) {
      expect(
        routeNames.has(name),
        `lib/hiddenTabScreens.ts lists "${name}" but no such route file exists under ${TABS_ROOT}`,
      ).toBe(true);
    }
  });

  it("no screen is registered twice across the layout and the data module", () => {
    // A name declared both inline and in the data module renders two
    // `Tabs.Screen` children with the same name, which Expo Router resolves
    // silently and unpredictably.
    const inline = layoutScreenNameLiterals();
    const duplicated = HIDDEN_TAB_SCREENS.map(([name]) => name).filter((name) =>
      inline.includes(name),
    );
    expect(duplicated).toEqual([]);
  });

  it("admin-only secondary routes are hidden from lower effective roles", () => {
    const adminOnly = MOBILE_SECONDARY_ROUTES.filter(
      (route) => route.minimumRole === "admin",
    );
    expect(adminOnly.map((route) => route.key)).toEqual(
      expect.arrayContaining([
        "inbound-webhooks",
        "migrations",
        "sending-settings",
        "custom-domains",
        "agency",
        "scim",
        "audit-sinks",
      ]),
    );
    for (const route of adminOnly) {
      expect(canAccessMobileSecondaryRoute(route, "owner")).toBe(true);
      expect(canAccessMobileSecondaryRoute(route, "admin")).toBe(true);
      expect(canAccessMobileSecondaryRoute(route, "editor")).toBe(false);
      expect(canAccessMobileSecondaryRoute(route, "viewer")).toBe(false);
      expect(canAccessMobileSecondaryRoute(route, null)).toBe(false);
      expect(canAccessMobileSecondaryRoute(route, null, "api_key")).toBe(false);
    }
  });

  it("resolves direct and nested secondary paths through the same guard policy", () => {
    expect(mobileSecondaryRouteForPath("/(tabs)/settings")?.key).toBe(
      "settings",
    );
    expect(mobileSecondaryRouteForPath("/settings/")?.key).toBe("settings");
    expect(mobileSecondaryRouteForPath("/migrations/run-123")?.key).toBe(
      "migrations",
    );
    expect(mobileSecondaryRouteForPath("/(tabs)/dashboard")).toBeNull();
  });

  it("treats legacy member as viewer-equivalent and default-denies API keys without scope claims", () => {
    const adminRoute = MOBILE_SECONDARY_ROUTES.find(
      (route) => route.minimumRole === "admin",
    );
    expect(adminRoute).toBeDefined();
    expect(
      canAccessMobileSecondaryRoute(adminRoute!, "member", "session"),
    ).toBe(false);
    expect(
      canAccessMobileCapability("workspace_settings", "member", "session"),
    ).toBe(false);
    expect(
      canAccessMobileCapability("workspace_settings", "owner", "session"),
    ).toBe(true);
    expect(
      canAccessMobileCapability("workspace_settings", "owner", "api_key"),
    ).toBe(false);
  });

  it("gives every More row whose reads are admin-floored an admin minimumRole", () => {
    // THE HOLE THIS CLOSES. The capability guard below validates role floors only
    // for MOBILE_CAPABILITIES, each of which declares explicit `apiOperations`. A
    // MobileSecondaryRoute row carries a `minimumRole` and NO apiOperations, so
    // nothing tied a nav row to the manifest floor of the endpoints its screen
    // actually calls. And the "admin-only secondary routes are hidden" test above
    // only inspects rows that ALREADY say admin — it proves declared rows are
    // enforced, never that a row needing admin declares it.
    //
    // `integrations` fell straight through both: it had no minimumRole while
    // GET /api/v1/integrations/connections and /{slug}/health are
    // session_minimum_role admin (reviewed) in the generated manifest. The mount
    // sites only ask for ScopeReadReports, so reading the Go alone says "any
    // role" — the manifest is the binding layer, and a viewer who tapped the row
    // got a guaranteed 403 with no honest message.
    const manifest = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "..",
          "..",
          "apps/api/internal/routeauth/manifest.json",
        ),
        "utf8",
      ),
    ) as {
      routes: {
        method: string;
        path: string;
        session_minimum_role: string;
        review_status: string;
      }[];
    };
    const rowFor = (method: string, path: string) =>
      manifest.routes.find((r) => r.method === method && r.path === path);

    /**
     * A row's READ endpoints, and only its reads.
     *
     * ── WHY EQUALITY, AND WHY READS ONLY ──────────────────────────────────
     * Three incompatible specifications for this guard were proposed, and they
     * matter because they catch different bugs.
     *
     * AT-LEAST-AS-STRICT catches only under-gating — a row that invites a
     * viewer straight into a 403. It is silent on OVER-gating, which is the
     * more common defect here and the more damaging one: a row gated above its
     * reads hides a screen from somebody the server would happily serve, and
     * because nothing ever errors, nobody finds out.
     *
     * EXACT EQUALITY against EVERY endpoint would fail every screen that
     * legitimately reads at viewer and writes at admin — which is most of them
     * and is the correct shape (`reviews`, `subject-lab`, `agent-mandates`).
     *
     * So: equality against the strictest floor of the row's READS. Writes are
     * gated IN-SCREEN, where a non-admin still sees the thing and is told
     * plainly what they cannot do to it.
     *
     * ── AND ONLY AGAINST `reviewed` MANIFEST ROWS ─────────────────────────
     * `mobileRoutesAdmin.ts` states the rule this has to respect: a row marked
     * `fail_closed_default` is AUTO-GENERATED and unchecked, while a `reviewed`
     * row is authoritative. The effective floor is the stricter of the manifest
     * row and the Go mount's scope wrapper, and only a reviewed row has had
     * that reconciliation done.
     *
     * Asserting equality against a guess is how a CORRECT nav row gets "fixed"
     * into a wrong one. `audit-sinks` is the live example: its manifest row
     * says viewer and is unreviewed, while the Go mount gates
     * `GET /api/v1/audit-sinks` behind `ScopeAuditRead` — a specific audit
     * scope, not a plain viewer read. Its admin row is right; the manifest is
     * what has not caught up.
     */
    const ROW_READS: Readonly<Record<string, [string, string][]>> = {
      integrations: [
        ["GET", "/api/v1/integrations/connections"],
        ["GET", "/api/v1/integrations/{slug}/health"],
      ],
      // src/api/smsInbox.ts:70,82,95,104 — the inbox's every read.
      sms: [["GET", "/api/v1/sms/conversations"]],
      "api-keys": [["GET", "/api/v1/api-keys"]],
      "agent-mandates": [["GET", "/api/v1/agent-mandates"]],
      scim: [["GET", "/api/v1/scim/tokens"]],
      billing: [["GET", "/api/v1/billing/plan-summary"]],
      // Unreviewed manifest rows are skipped by the assertion below, but they
      // stay listed so the reads are recorded and the check starts working the
      // moment the row is reviewed.
      reviews: [["GET", "/api/v1/reviews"]],
      "audit-sinks": [["GET", "/api/v1/audit-sinks"]],
    };

    const RANK = ["viewer", "editor", "admin", "owner"] as const;
    const rank = (role: string): number => {
      const i = RANK.indexOf(role as (typeof RANK)[number]);
      return i < 0 ? 0 : i;
    };

    let compared = 0;
    for (const [key, reads] of Object.entries(ROW_READS)) {
      const row = MOBILE_SECONDARY_ROUTES.find((r) => r.key === key);
      expect(row, `no secondary route named ${key}`).toBeDefined();
      const manifestRows = reads.map(([method, path]) => {
        const found = rowFor(method, path);
        expect(
          found,
          `${method} ${path} must exist in the generated API policy manifest`,
        ).toBeDefined();
        return found!;
      });
      // One guessed floor makes the "strictest" a guess too.
      if (manifestRows.some((r) => r.review_status !== "reviewed")) continue;
      compared += 1;
      const strictest = manifestRows
        .map((r) => r.session_minimum_role)
        .reduce((worst, f) => (rank(f) > rank(worst) ? f : worst), "viewer");
      // An absent `minimumRole` means viewer — the row is open to everyone.
      const declared = row?.minimumRole ?? "viewer";
      expect(
        declared,
        `${key} reads at ${strictest} but its nav row declares ${declared}. ` +
          (rank(declared) > rank(strictest)
            ? "That OVER-gates: a role the server would serve cannot even see the screen, and nothing errors, so nobody finds out. Gate the write buttons in-screen instead."
            : "That UNDER-gates: the row invites a role straight into a 403."),
      ).toBe(strictest);
    }
    // Vacuity floor: if every row became unreviewed, the loop above would skip
    // everything and pass while proving nothing.
    expect(
      compared,
      "no row was actually compared — every listed read resolved to an unreviewed manifest row",
    ).toBeGreaterThanOrEqual(4);
  });
  it("keeps mobile capability roles aligned with the generated API policy manifest", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "..",
          "..",
          "apps/api/internal/routeauth/manifest.json",
        ),
        "utf8",
      ),
    ) as {
      schema_version: number;
      routes: {
        method: string;
        path: string;
        session_minimum_role: string;
      }[];
    };

    expect(manifest.schema_version).toBe(1);
    for (const capability of Object.values(MOBILE_CAPABILITIES)) {
      for (const operation of capability.apiOperations) {
        const policy = manifest.routes.find(
          (route) =>
            route.method === operation.method && route.path === operation.path,
        );
        expect(
          policy,
          `${operation.method} ${operation.path} must exist in the generated API policy manifest`,
        ).toBeDefined();
        expect(policy?.session_minimum_role).toBe(capability.minimumRole);
      }
    }
  });

  it("normalizes effective roles before route access checks", () => {
    expect(normalizeMobileAccessRole(" Owner ")).toBe("owner");
    expect(normalizeMobileAccessRole("VIEWER")).toBe("viewer");
    expect(normalizeMobileAccessRole("unknown")).toBeNull();
  });

  it("secondary entity routes match the shared deep-link route map", () => {
    for (const route of MOBILE_SECONDARY_ROUTES) {
      if (!route.entityKey) continue;
      const path = mobilePath(route.entityKey, "example-id");
      expect(path).not.toBeNull();
      expect(path?.startsWith(`${route.route}/`)).toBe(true);
    }
  });

  it("Android autoVerify covers canonical entity universal links", () => {
    const verifiedFilters = appConfig.expo.android.intentFilters.filter(
      (filter) => filter.autoVerify === true,
    );
    const appLinkPrefixes: string[] = [];
    const exactAppLinkPaths: string[] = [];
    for (const filter of verifiedFilters) {
      for (const entry of filter.data as unknown[]) {
        const maybeAppLink = entry as {
          scheme?: string;
          host?: string;
          pathPrefix?: string;
          path?: string;
        };
        if (
          maybeAppLink.scheme === "https" &&
          maybeAppLink.host === "app.moosewave.com" &&
          typeof maybeAppLink.pathPrefix === "string"
        ) {
          appLinkPrefixes.push(maybeAppLink.pathPrefix);
        }
        if (
          maybeAppLink.scheme === "https" &&
          maybeAppLink.host === "app.moosewave.com" &&
          typeof maybeAppLink.path === "string"
        ) {
          exactAppLinkPaths.push(maybeAppLink.path);
        }
      }
    }

    expect(exactAppLinkPaths).toEqual(
      expect.arrayContaining([
        "/auth",
        "/auth/magic",
        "/auth/reset",
        "/auth/oauth-return",
        "/magic-link",
        "/reset-password",
      ]),
    );
    // NATIVE#4 — this used to assert the single blanket prefix `/app`, which
    // covered the entity links by claiming EVERY dashboard URL, including the two
    // iOS deliberately leaves to Safari. The coverage requirement is unchanged;
    // the mechanism is now one prefix per entity that mobile can actually route.
    // appLinkClaimParity.test.ts holds the claim set to the shared registry.
    expect(appLinkPrefixes).not.toContain("/app");
    for (const slug of ["subscribers", "campaigns", "approvals"]) {
      expect(appLinkPrefixes).toContain(`/app/${slug}`);
    }
    expect(exactAppLinkPaths).not.toContain("/browser-auth/magic");
    expect(exactAppLinkPaths).not.toContain("/browser-auth/reset");
  });
});
