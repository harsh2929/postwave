/**
 * The SDK contract as a coverage anchor.
 *
 * Split from desktopOnlyCapabilities.test.ts along the same seam as the module
 * it guards: that file's table is rendered copy held to the message catalogue,
 * and this one's is an engineering ledger nobody reads in the app.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  DESKTOP_CARD_CAPABILITIES,
  DESKTOP_CLIENT_ONLY_CAPABILITIES,
  SDK_RESOURCE_COVERAGE,
  SERVER_ONLY_CAPABILITIES,
} from "./capabilityCoverage";
import { MOBILE_SECONDARY_ROUTES } from "./mobileRouteManifest";

describe("the SDK contract is the third anchor (completeness pass, item 19)", () => {
  /**
   * Why a third table at all. The two above are anchored to UI directories, so
   * a capability with NO screen on the anchor surface cannot produce a row —
   * it is invisible to the honesty table BY CONSTRUCTION, not by oversight.
   *
   * `developer-marketplace` is the worked example the audit named: a full Go
   * surface with an admin review queue, a complete SDK resource, marketing copy
   * — and no human UI anywhere. It has no desktop sidebar section and no
   * apps/web dashboard directory, so neither existing guard could ever mention
   * it. Anchoring to what the platform PUBLISHES is the only framing under
   * which an API-only capability is representable.
   */
  const sdkResources = (): string[] =>
    readdirSync(
      join(__dirname, "..", "..", "..", "..", "packages", "sdk-ts", "src", "resources"),
      { withFileTypes: true },
    )
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name.replace(/\.ts$/u, ""))
      .filter((name) => name !== "_base")
      .sort();

  it("finds the SDK resources (guards against a silently-empty scan)", () => {
    expect(sdkResources().length).toBeGreaterThan(50);
  });

  it("records a verdict for every published SDK resource", () => {
    const missing = sdkResources().filter(
      (name) => SDK_RESOURCE_COVERAGE[name] === undefined,
    );
    expect(
      missing,
      `the SDK publishes ${missing.join(", ")} with no coverage verdict — decide whether mobile has a screen, folds it into one, genuinely lacks it, or whether it is api_only`,
    ).toEqual([]);
  });

  it("claims no resource the SDK has dropped", () => {
    const live = new Set(sdkResources());
    const stale = Object.keys(SDK_RESOURCE_COVERAGE).filter(
      (key) => !live.has(key),
    );
    expect(
      stale,
      `these have a verdict but are no longer SDK resources: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("produces a row for developer-marketplace — the case that motivated it", () => {
    // The audit's instruction was explicit: if the new table does not produce a
    // row for developer-marketplace, the fix is wrong. This asserts the fix is
    // the right one rather than a table that merely compiles.
    const verdict = SDK_RESOURCE_COVERAGE["developer-marketplace"];
    expect(verdict).toBeDefined();
    expect(verdict?.kind).toBe("api_only");
  });

  it("makes every api_only verdict say WHY, in a sentence", () => {
    // `api_only` is the one verdict that could be used to wave a real gap away.
    // Requiring prose is what stops it becoming a silent escape hatch.
    for (const [name, coverage] of Object.entries(SDK_RESOURCE_COVERAGE)) {
      if (coverage.kind !== "api_only") continue;
      expect(
        coverage.reason.trim().length,
        `${name} is api_only with no reason`,
      ).toBeGreaterThan(40);
    }
  });

  it("points every `route` verdict at a real mobile destination", () => {
    const routeKeys = new Set(MOBILE_SECONDARY_ROUTES.map((route) => route.key));
    const tabs = ["dashboard", "campaigns", "subscribers", "approvals", "settings"];
    for (const [name, coverage] of Object.entries(SDK_RESOURCE_COVERAGE)) {
      if (coverage.kind !== "route") continue;
      expect(
        routeKeys.has(coverage.mobileKey) || tabs.includes(coverage.mobileKey),
        `${name} claims the mobile screen ${coverage.mobileKey}, which does not exist`,
      ).toBe(true);
    }
  });

  it("points every `inside` verdict at a real mobile screen", () => {
    const routeKeys = new Set(MOBILE_SECONDARY_ROUTES.map((route) => route.key));
    const tabs = ["dashboard", "campaigns", "subscribers", "approvals", "settings"];
    for (const [name, coverage] of Object.entries(SDK_RESOURCE_COVERAGE)) {
      if (coverage.kind !== "inside") continue;
      expect(
        routeKeys.has(coverage.hostKey) || tabs.includes(coverage.hostKey),
        `${name} folds into ${coverage.hostKey}, which is not a mobile screen`,
      ).toBe(true);
    }
  });

  /**
   * The assertion above checks the HOST EXISTS. It never checked that the host
   * OFFERS the thing, and that gap shipped a lie: `audience-destinations` was
   * recorded as `inside` -> `integrations` while `app/(tabs)/integrations.tsx`
   * contained zero mentions of it and no API layer reached the endpoints.
   * `inside` is a positive claim -- "we ship this, folded into that screen" --
   * so a host that never names the capability makes the table dishonest in the
   * one direction it exists to prevent.
   *
   * This looks for the capability's name in the host's own source. It is a weak
   * signal deliberately: a false NEGATIVE (host offers it under a different
   * word) costs one comment in the table, while a false POSITIVE is the failure
   * we actually had.
   */
  it("every `inside` host actually mentions what it hosts", () => {
    // A screen plus ONLY the components it actually IMPORTS.
    //
    // Two failure modes had to be closed at once, and each is the other's
    // opposite. Reading the screen alone condemned `auth-checks`, which is real
    // but lives in components/deliverability/*. Reading the whole component
    // DIRECTORY then let an UNMOUNTED file satisfy the claim -- proven by
    // mutation: deleting <AudienceDestinationsPanel /> from the screen left this
    // green because the panel file still sat in the directory. Following
    // imports is the only version that tracks what the screen renders.
    const readSource = (key: string): string => {
      let screen = "";
      for (const file of [
        join(__dirname, "..", "..", "app", "(tabs)", `${key}.tsx`),
        join(__dirname, "..", "..", "app", `${key}.tsx`),
      ]) {
        if (existsSync(file)) screen += readFileSync(file, "utf8");
      }
      if (!screen) return "";
      let text = screen;
      const importRE = new RegExp(
        `from "@/components/${key}/([A-Za-z0-9_.-]+)"`,
        "g",
      );
      for (const match of screen.matchAll(importRE)) {
        const base = match[1];
        if (!base) continue;
        for (const ext of [".tsx", ".ts"]) {
          const file = join(__dirname, "..", "components", key, `${base}${ext}`);
          if (existsSync(file)) {
            text += readFileSync(file, "utf8");
            break;
          }
        }
      }
      return text;
    };
    const checked: string[] = [];
    for (const [name, coverage] of Object.entries(SDK_RESOURCE_COVERAGE)) {
      if (coverage.kind !== "inside") continue;
      const src = readSource(coverage.hostKey);
      if (!src) continue; // tab screens live elsewhere; the test above covers existence
      checked.push(name);
      // The host names a capability in ITS vocabulary, not the SDK's. Extra
      // synonyms are declared here rather than loosening the match globally.
      const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
        "auth-checks": ["spf", "dkim", "dmarc", "authenticat"],
      };
      const needles = [
        ...name.split("-").filter((part) => part.length > 3),
        ...(SYNONYMS[name] ?? []),
      ];
      const mentioned = needles.some((part) =>
        src.toLowerCase().includes(part.toLowerCase()),
      );
      expect(
        mentioned,
        `${name} is recorded as living INSIDE ${coverage.hostKey}, but that screen never mentions it. ` +
          `Either surface it there or record it as { kind: "absent", reason }.`,
      ).toBe(true);
    }
    expect(checked.length).toBeGreaterThan(0);
  });

  it("gives every desktop-client-only capability a written reason", () => {
    // translations and a11y-check have a desktop client, no SDK resource and no
    // sidebar section, so all three anchors would otherwise imply mobile covers
    // them. "Mobile doesn't do this" should be a verdict, not an absence.
    expect(DESKTOP_CLIENT_ONLY_CAPABILITIES.length).toBeGreaterThan(0);
    for (const entry of DESKTOP_CLIENT_ONLY_CAPABILITIES) {
      expect(entry.key.trim().length).toBeGreaterThan(0);
      expect(
        entry.reason.trim().length,
        `${entry.key} has no reason`,
      ).toBeGreaterThan(40);
    }
  });
});

describe("capabilities that render as desktop CARDS (the fourth blind spot)", () => {
  /**
   * The three anchors above are keyed on a sidebar catalogue, a route
   * directory and an SDK resource list. A capability that is a card inside
   * somebody else's page, with no SDK resource, has none of those — so it is
   * invisible to all three by construction, which is the same failure the
   * other two fixes addressed at different levels.
   *
   * This asserts against the DESKTOP SOURCE rather than against the table's own
   * fields, so the entries cannot drift into describing components that no
   * longer exist, and a card that is deleted on desktop stops being claimed
   * here.
   */
  const DESKTOP_SRC = join(__dirname, "..", "..", "..", "desktop", "src");

  function desktopComponentFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        if (entry.name.endsWith(".tsx")) out.push(entry.name.replace(/\.tsx$/u, ""));
      }
    };
    walk(DESKTOP_SRC);
    return out;
  }

  it("finds desktop components (guards against an empty scan)", () => {
    expect(desktopComponentFiles().length).toBeGreaterThan(100);
  });

  it("names a real desktop component for every card capability", () => {
    const components = new Set(desktopComponentFiles());
    expect(DESKTOP_CARD_CAPABILITIES.length).toBeGreaterThan(0);
    for (const entry of DESKTOP_CARD_CAPABILITIES) {
      expect(
        components.has(entry.component),
        `${entry.capability} claims desktop component ${entry.component}, which does not exist — either it was renamed or this verdict is stale`,
      ).toBe(true);
    }
  });

  it("gives every card capability a stated verdict", () => {
    for (const entry of DESKTOP_CARD_CAPABILITIES) {
      expect(entry.capability.trim().length).toBeGreaterThan(0);
      expect(entry.coverage.kind).toBeTruthy();
    }
  });
});

describe("server-complete capabilities with no client anywhere", () => {
  /**
   * The fifth situation the four anchors cannot express: a complete server and
   * no client on ANY surface. Filing these as "absent on mobile" would record a
   * product-wide gap as a phone problem, which is exactly how they stayed
   * invisible through several audits.
   */
  it("names a real Go source for each, and gives a reason", () => {
    expect(SERVER_ONLY_CAPABILITIES.length).toBeGreaterThan(0);
    for (const entry of SERVER_ONLY_CAPABILITIES) {
      expect(
        existsSync(join(__dirname, "..", "..", "..", "..", entry.source)),
        `${entry.capability} cites ${entry.source}, which does not exist`,
      ).toBe(true);
      expect(
        entry.note.trim().length,
        `${entry.capability} has no note`,
      ).toBeGreaterThan(60);
    }
  });

  it("does not double-file anything already covered by another anchor", () => {
    // A capability with an SDK resource has a verdict there; recording it here
    // as well would let two tables disagree about the same thing.
    const sdkKeys = new Set(Object.keys(SDK_RESOURCE_COVERAGE));
    for (const entry of SERVER_ONLY_CAPABILITIES) {
      const slug = entry.source.split("/").at(-2) ?? "";
      expect(
        sdkKeys.has(slug),
        `${entry.capability} (${slug}) also has an SDK_RESOURCE_COVERAGE verdict — pick one anchor`,
      ).toBe(false);
    }
  });
});
