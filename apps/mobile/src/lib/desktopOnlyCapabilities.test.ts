/**
 * THE RATCHET FOR MAP#73.
 *
 * The finding is that More's section headings imply coverage the app does not
 * have. A closing "not on this phone" block only fixes that while the block is
 * TRUE, and a hand-maintained list of missing features is exactly the kind of
 * copy that rots — in the direction that tells a user a shipped feature does
 * not exist. So the block is data, and it is reconciled against both ends.
 *
 * Reading apps/desktop's own catalogue from a mobile test is a deliberate
 * cross-surface coupling, and the same one `nav.consistency.test.ts` already
 * uses against `@postwave/nav` and the generated API policy manifest: the
 * VALUE is that it fails when the two surfaces drift, forcing whoever adds a
 * desktop section to say what mobile does about it. A vacuous-scan guard is
 * asserted first, because a path typo would otherwise make every assertion
 * below pass with nothing to check.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DESKTOP_ONLY_CAPABILITIES,
  desktopOnlyAccessibilityLabel,
  desktopOnlyBody,
  desktopOnlyHeading,
  desktopOnlyRows,
} from "./desktopOnlyCapabilities";
import {
  DESKTOP_SECTION_COVERAGE,
  OUTBOUND_WEBHOOK_DIAGNOSTIC_COVERAGE,
} from "./desktopSectionCoverage";
import { WEB_SECTION_COVERAGE } from "./webSectionCoverage";
import { MOBILE_SECONDARY_ROUTES } from "./mobileRouteManifest";
import { knownNavLinkSlugs } from "./navDeepLinks";

const DESKTOP_CATALOGUE = join(
  __dirname,
  "..",
  "..",
  "..",
  "desktop",
  "src",
  "components",
  "SidebarNavigationCatalog.tsx",
);

/** Every `navItem("<id>", …)` in desktop's sidebar catalogue. */
function desktopSectionIds(): string[] {
  const source = readFileSync(DESKTOP_CATALOGUE, "utf8");
  const ids = [...source.matchAll(/navItem\("([A-Za-z]+)"/gu)].map(
    (match) => match[1] as string,
  );
  return [...new Set(ids)];
}

function runtimeTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...runtimeTypeScriptFiles(path));
      continue;
    }
    if (
      /\.(?:ts|tsx)$/u.test(entry.name) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/u.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

describe("desktop → mobile coverage table", () => {
  const sections = desktopSectionIds();

  it("finds desktop's sidebar catalogue (guards a silently-empty scan)", () => {
    expect(sections.length).toBeGreaterThan(40);
    expect(sections).toContain("dashboard");
    expect(sections).toContain("settings");
  });

  it("says what mobile does about EVERY desktop section", () => {
    const unanswered = sections.filter(
      (id) => !Object.hasOwn(DESKTOP_SECTION_COVERAGE, id),
    );
    expect(
      unanswered,
      `apps/desktop grew ${unanswered.join(", ")}. Add each to ` +
        `DESKTOP_SECTION_COVERAGE as a route, an "inside" fold, or an ` +
        `absence — an unanswered section is the More menu implying coverage ` +
        `it does not have, which is the finding this table closes.`,
    ).toEqual([]);
  });

  it("does not answer for a desktop section that no longer exists", () => {
    // The other direction: a stale row would keep claiming mobile "covers"
    // something desktop deleted, and would hide a genuine new absence.
    const known = new Set(sections);
    const stale = Object.keys(DESKTOP_SECTION_COVERAGE).filter(
      (id) => !known.has(id),
    );
    expect(stale).toEqual([]);
  });

  it("resolves every claimed mobile screen to one the app actually ships", () => {
    // `knownNavLinkSlugs` is built from MOBILE_SECONDARY_ROUTES plus the five
    // bottom tabs, so it is exactly "the destinations this app has". Both the
    // `route` claims and the `inside` HOST screens are checked: a fold into a
    // screen that no longer exists is a capability quietly lost, and it would
    // read here as covered.
    const reachable = new Set(knownNavLinkSlugs());
    const broken = Object.entries(DESKTOP_SECTION_COVERAGE)
      .map(([id, coverage]) => {
        if (coverage.kind === "route") {
          return { id, claim: coverage.mobileKey };
        }
        if (coverage.kind === "inside") {
          return { id, claim: coverage.hostKey };
        }
        return null;
      })
      .filter((entry): entry is { id: string; claim: string } => entry !== null)
      .filter(({ claim }) => !reachable.has(claim));
    expect(broken).toEqual([]);
  });
});

describe("the not-on-this-phone block", () => {
  it("only lists capabilities the coverage table calls absent", () => {
    // The dangerous rot: telling a user a feature is missing after it shipped.
    // When Affiliates lands on mobile its coverage flips to `route` and this
    // fails until the row is deleted.
    const wrong = DESKTOP_ONLY_CAPABILITIES.filter(
      (capability) =>
        DESKTOP_SECTION_COVERAGE[capability.section]?.kind !== "absent",
    ).map((capability) => capability.section);
    expect(wrong).toEqual([]);
  });

  it("lists EVERY absence, so the block cannot quietly under-report", () => {
    const absent = Object.entries(DESKTOP_SECTION_COVERAGE)
      .filter(([, coverage]) => coverage.kind === "absent")
      .map(([id]) => id)
      .sort();
    const listed = DESKTOP_ONLY_CAPABILITIES.map((c) => c.section).sort();
    expect(listed).toEqual(absent);
  });

  it("never names a mobile route key as an absence", () => {
    const reachable = new Set(knownNavLinkSlugs());
    const contradictions = DESKTOP_ONLY_CAPABILITIES.map(
      (c) => c.section,
    ).filter((section) => reachable.has(section.toLowerCase()));
    expect(contradictions).toEqual([]);
  });

  it("renders resolved copy, not raw catalogue keys", () => {
    const rows = desktopOnlyRows();
    expect(rows.length).toBe(DESKTOP_ONLY_CAPABILITIES.length);
    for (const row of rows) {
      // `msg()` returns the KEY when a catalogue entry is missing, which is
      // the failure this asserts against — a key on screen is not copy.
      expect(row.label).not.toContain("desktopOnly.");
      expect(row.hint).not.toContain("desktopOnly.");
      expect(row.label.trim().length).toBeGreaterThan(0);
      expect(row.hint.trim().length).toBeGreaterThan(0);
    }
    expect(desktopOnlyHeading()).toBe("Not on this phone");
    expect(desktopOnlyBody()).toContain("desktop");
  });

  it("speaks the whole block in one breath, naming each capability", () => {
    // A block whose rows are unlabelled text nodes reads to VoiceOver as six
    // orphaned phrases with no explanation of why they are there.
    const spoken = desktopOnlyAccessibilityLabel();
    for (const row of desktopOnlyRows()) {
      expect(spoken).toContain(row.label);
    }
    expect(spoken).toContain("Not on this phone");
  });
});

describe("the More menu's own taxonomy", () => {
  it("keeps every secondary route in one of the six declared sections", () => {
    // The headings are the claim; a row that fell out of all of them would be
    // unreachable in More even though the route exists.
    const sections = new Set(
      MOBILE_SECONDARY_ROUTES.map((route) => route.moreSection),
    );
    expect([...sections].sort()).toEqual([
      "Account",
      "Audience",
      "Content",
      "Enterprise",
      "Sending",
      "Tools",
    ]);
  });

  it("separates the canned signed test from the custom-payload simulator", () => {
    // GATE#7. Mobile POSTs /outbound-webhooks/{id}/test from Settings, but it
    // does not POST arbitrary payloads to /playground/fire or inspect the live
    // request/receiver evidence. One positive and one negative verdict keep
    // either half from silently standing in for the other.
    expect(OUTBOUND_WEBHOOK_DIAGNOSTIC_COVERAGE.cannedSignedTest).toEqual({
      kind: "inside",
      hostKey: "settings",
    });
    expect(OUTBOUND_WEBHOOK_DIAGNOSTIC_COVERAGE.customPayloadSimulator).toEqual(
      { kind: "absent" },
    );
    expect(DESKTOP_SECTION_COVERAGE.webhookSimulator).toBe(
      OUTBOUND_WEBHOOK_DIAGNOSTIC_COVERAGE.customPayloadSimulator,
    );
    expect(DESKTOP_ONLY_CAPABILITIES.map((c) => c.section)).toContain(
      "webhookSimulator",
    );

    const row = desktopOnlyRows().find(
      (candidate) => candidate.section === "webhookSimulator",
    );
    expect(row?.label).toBe("Custom webhook simulator");
    expect(row?.hint).toContain("canned signed test");
  });

  it("has no mobile runtime path to arbitrary fire or receipt endpoints", () => {
    const mobileRoot = join(__dirname, "..", "..");
    const runtimeFiles = [
      ...runtimeTypeScriptFiles(join(mobileRoot, "src")),
      ...runtimeTypeScriptFiles(join(mobileRoot, "app")),
    ];
    const forbidden = runtimeFiles.filter((path) =>
      /outbound-webhooks\/playground\/fires?(?:[/"'`]|$)/u.test(
        readFileSync(path, "utf8"),
      ),
    );

    expect(runtimeFiles.length).toBeGreaterThan(100);
    expect(forbidden).toEqual([]);
  });

  it("carries no orphaned desktopOnly copy, in either direction", () => {
    // GATE#8. `messagesEn.ts` held desktopOnly.referrals.* and
    // desktopOnly.helpdesk.* long after both shipped as real mobile routes, and
    // i18nCoverage could not see it: that guard proves every key a READER wants
    // exists, never that every key HAS a reader. So an obsolete "not on this
    // phone" string survives the build and only a human reading the menu notices.
    //
    // Both directions are asserted here, because deleting today's three orphans
    // without the guard just resets the clock on the next one.
    const catalogue = readFileSync(join(__dirname, "messagesEn.ts"), "utf8");
    const declared = new Set(
      DESKTOP_ONLY_CAPABILITIES.map((capability) => capability.section),
    );
    const keyed = new Set(
      [
        ...catalogue.matchAll(/"desktopOnly\.([A-Za-z]+)\.(?:label|hint)"/g),
      ].map((match) => match[1]),
    );
    expect([...keyed].sort()).toEqual([...declared].sort());
  });
});

describe("web is a second anchor for coverage (GUARD#2)", () => {
  // The desktop-anchored table could be complete and green while mobile fell
  // behind on anything WEB ships that desktop does not — the comparison simply
  // was not being made. This is the same ratchet pointed at the other surface.
  /**
   * Top-level sections AND their immediate children.
   *
   * The original version returned only the top level, and that had the exact
   * structural blindness this table exists to prevent, one level down:
   * `settings/team`, `settings/custom-fields` and `subscribers/paid-members`
   * are whole capabilities, each silently absorbed by its parent's verdict. An
   * adversarial sweep found them; nothing here could have.
   *
   * ONE level, deliberately. Below that the directories are `[id]` params and
   * view fragments of a capability already covered, not capabilities of their
   * own — so recursing further would produce noise a reader learns to skip.
   */
  const WEB_APP_ROOT = join(
    __dirname,
    "..",
    "..",
    "..",
    "web",
    "src",
    "app",
    "(dashboard)",
    "app",
  );
  const webSections = (): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(WEB_APP_ROOT, { withFileTypes: true })) {
      // The SAME two exclusions the child loop below applies, applied here too.
      // They were previously only enforced one level down, so a `_`-prefixed
      // PRIVATE folder at the top level — `_content-automation`, `_engagement`,
      // each holding one colocated component and no `page.tsx` — was reported as
      // an untriaged capability. That is not a coverage gap, it is a directory
      // Next.js never routes, and demanding a mobile verdict for it made this
      // ratchet cry wolf on the one signal it exists to make trustworthy.
      if (
        !entry.isDirectory() ||
        entry.name.startsWith("[") ||
        entry.name.startsWith("_")
      ) {
        continue;
      }
      out.push(entry.name);
      for (const child of readdirSync(join(WEB_APP_ROOT, entry.name), {
        withFileTypes: true,
      })) {
        // `[id]`-style dynamic segments are a view OF the parent capability,
        // and `_`-prefixed directories are Next.js PRIVATE folders — colocated
        // components that are definitionally not routes at all.
        if (
          !child.isDirectory() ||
          child.name.startsWith("[") ||
          child.name.startsWith("_")
        ) {
          continue;
        }
        out.push(`${entry.name}/${child.name}`);
      }
    }
    return out.sort();
  };

  it("walks one level deep (the blindness that hid five capabilities)", () => {
    const sections = webSections();
    expect(sections).toContain("settings");
    // The specific keys an adversarial sweep found hiding behind their parent.
    expect(sections).toContain("settings/team");
    expect(sections).toContain("settings/custom-fields");
    expect(sections).toContain("subscribers/paid-members");
    expect(sections.filter((s) => s.includes("/")).length).toBeGreaterThan(10);
  });

  it("records a verdict for every web dashboard section", () => {
    const missing = webSections().filter(
      (section) => WEB_SECTION_COVERAGE[section] === undefined,
    );
    expect(
      missing,
      `web grew ${missing.join(", ")} with no coverage verdict — decide whether mobile has it, folds it into another screen, or genuinely lacks it`,
    ).toEqual([]);
  });

  it("claims no web section that has been removed", () => {
    const live = new Set(webSections());
    const stale = Object.keys(WEB_SECTION_COVERAGE).filter(
      (key) => !live.has(key),
    );
    expect(
      stale,
      `these have a coverage verdict but no longer exist on web: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * BOTH kinds, not just `inside`.
   *
   * This block previously skipped every `kind: "route"` verdict, so the 18-odd
   * claims of the form "mobile HAS this, at screen X" went unchecked — while
   * the desktop twin forty lines above validates both and says so. The half it
   * skipped is the half that makes a POSITIVE claim about mobile's coverage,
   * which is the more consequential one to get wrong: an `inside` verdict
   * pointing at nothing is a broken cross-reference, but a `route` verdict
   * pointing at nothing asserts a capability the phone does not have.
   */
  it("points every verdict at a real mobile screen, route and inside alike", () => {
    const routeKeys = new Set(
      MOBILE_SECONDARY_ROUTES.map((route) => route.key),
    );
    const tabs = [
      "dashboard",
      "campaigns",
      "subscribers",
      "approvals",
      "settings",
    ];
    const known = (key: string) => routeKeys.has(key) || tabs.includes(key);

    let checked = 0;
    const broken: string[] = [];
    for (const [section, coverage] of Object.entries(WEB_SECTION_COVERAGE)) {
      if (coverage.kind === "route") {
        checked += 1;
        if (!known(coverage.mobileKey)) {
          broken.push(
            `${section} claims mobile screen "${coverage.mobileKey}", which does not exist`,
          );
        }
        continue;
      }
      if (coverage.kind === "inside") {
        checked += 1;
        if (!known(coverage.hostKey)) {
          broken.push(
            `${section} folds into "${coverage.hostKey}", which is not a mobile screen`,
          );
        }
      }
    }
    // Vacuity floor, matching the desktop twin and capabilityCoverage. Without
    // it, a table that became entirely `absent` would pass having validated
    // nothing — and the file header states a non-vacuous scan is asserted
    // first precisely so a typo cannot make everything below pass.
    expect(
      checked,
      "no route/inside verdict was validated — the table looks empty or entirely absent",
    ).toBeGreaterThan(20);
    expect(broken).toEqual([]);
  });
});
