/**
 * The composed catalogue — what happens when four sources share one ranker.
 *
 * paletteItems.test.ts pins the ranker and the original two sources; this
 * file pins the composition: no id collides across sources, the source order
 * is the tie-break, the empty-query list stays a launcher rather than a dump,
 * and the queries the register names ("new camp", "passkey", "telemetry")
 * land where a desktop user would expect.
 */
import { describe, expect, it } from "vitest";

import {
  buildPaletteItems,
  dedupePaletteItems,
  filterPaletteItems,
  paletteItemBadge,
  paletteItemTarget,
  type PaletteAccess,
  type PaletteItem,
} from "./paletteItems";

const editor: PaletteAccess = { role: "editor", mode: "session", online: true };
const viewer: PaletteAccess = { role: "viewer", mode: "session", online: true };

const top = (access: PaletteAccess, query: string) =>
  filterPaletteItems(buildPaletteItems(access), query)[0]?.id;
const kindsOf = (items: readonly PaletteItem[]) => items.map((i) => i.kind);

describe("buildPaletteItems — composition", () => {
  it("has no duplicate id for any role × mode", () => {
    for (const role of ["viewer", "member", "editor", "admin", "owner", null]) {
      for (const mode of ["session", "api_key"] as const) {
        const ids = buildPaletteItems({ role, mode, online: true }).map(
          (item) => item.id,
        );
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("orders sources: screens, creation verbs, settings sections, actions", () => {
    const kinds = kindsOf(buildPaletteItems(editor));
    expect(kinds.lastIndexOf("navigation")).toBeLessThan(
      kinds.indexOf("create"),
    );
    expect(kinds.lastIndexOf("create")).toBeLessThan(kinds.indexOf("settings"));
    expect(kinds.lastIndexOf("settings")).toBeLessThan(kinds.indexOf("action"));
  });

  it("withholds the creation verbs from a viewer but keeps the settings sections", () => {
    const kinds = kindsOf(buildPaletteItems(viewer));
    expect(kinds).not.toContain("create");
    expect(kinds).toContain("settings");
  });

  it("withholds the creation verbs without an online session", () => {
    expect(kindsOf(buildPaletteItems({ ...editor, online: false }))).not.toContain(
      "create",
    );
  });

  it("still carries what it always did", () => {
    const ids = buildPaletteItems(editor).map((item) => item.id);
    for (const id of ["nav:dashboard", "nav:settings", "action:sign-out"]) {
      expect(ids).toContain(id);
    }
  });
});

describe("dedupePaletteItems", () => {
  const item = (id: string, title: string): PaletteItem => ({
    id,
    kind: "navigation",
    title,
    icon: "settings",
  });

  it("keeps the first occurrence and the original order", () => {
    const out = dedupePaletteItems([
      item("a", "first a"),
      item("b", "b"),
      item("a", "second a"),
    ]);
    expect(out.map((i) => i.title)).toEqual(["first a", "b"]);
  });
});

describe("ranking across sources", () => {
  it("'camp' still lands on the Campaigns screen, not the verb", () => {
    expect(top(editor, "camp")).toBe("nav:campaigns");
  });

  it("'new camp' lands on the verb", () => {
    expect(top(editor, "new camp")).toBe("create:campaign");
  });

  it("'settings' lands on the screen before any of its sections", () => {
    expect(top(editor, "settings")).toBe("nav:settings");
  });

  it("'app lock' lands on the section", () => {
    expect(top(editor, "app lock")).toBe("settings:app-lock");
  });

  it("'telemetry' lands on the Privacy section", () => {
    expect(top(editor, "telemetry")).toBe("settings:telemetry");
  });

  it("'passkey' finds Two-factor and devices", () => {
    const ids = filterPaletteItems(buildPaletteItems(editor), "passkey").map(
      (item) => item.id,
    );
    expect(ids).toContain("settings:security");
  });

  it("an empty query never dumps verbs or sections", () => {
    const kinds = new Set(
      kindsOf(filterPaletteItems(buildPaletteItems(editor), "", { limit: 50 })),
    );
    expect(kinds).toEqual(new Set(["navigation"]));
  });

  it("a recently used verb comes back at the top of the empty list", () => {
    const out = filterPaletteItems(buildPaletteItems(editor), "", {
      recentIds: ["create:list"],
    });
    expect(out[0]?.id).toBe("create:list");
  });
});

describe("paletteItemBadge / paletteItemTarget", () => {
  const items = buildPaletteItems(editor);
  const byKind = (kind: PaletteItem["kind"]) =>
    items.find((item) => item.kind === kind)!;

  it("badges every kind but plain navigation", () => {
    expect(paletteItemBadge(byKind("navigation"))).toBeUndefined();
    expect(paletteItemBadge(byKind("action"))).toBe("Action");
    expect(paletteItemBadge(byKind("create"))).toBe("New");
    expect(paletteItemBadge(byKind("settings"))).toBe("Settings");
  });

  it("targets a route with its params, and no target for an action", () => {
    expect(paletteItemTarget(byKind("navigation"))).toEqual({
      pathname: byKind("navigation").route,
    });
    expect(paletteItemTarget(byKind("create"))).toEqual({
      pathname: "/(tabs)/campaigns",
      params: { new: "1" },
    });
    expect(paletteItemTarget(byKind("settings"))).toEqual({
      pathname: "/(tabs)/settings",
      params: { anchor: "account" },
    });
    expect(paletteItemTarget(byKind("action"))).toBeNull();
  });
});
