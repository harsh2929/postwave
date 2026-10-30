import { describe, expect, it } from "vitest";
import {
  NAV_ENTRIES,
  SURFACES,
  type Surface,
  entriesInGroup,
  entryExposesSurface,
  getEntry,
  labelFor,
  navForSurface,
  routeFor,
  shortLabelFor,
  surfacesFor,
} from "./index";

describe("manifest internal consistency", () => {
  it("has unique keys", () => {
    const keys = NAV_ENTRIES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every entry has a non-empty label and iconKey", () => {
    for (const e of NAV_ENTRIES) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.iconKey.length).toBeGreaterThan(0);
    }
  });

  it("every entry is exposed on at least one surface", () => {
    for (const e of NAV_ENTRIES) {
      expect(surfacesFor(e).length).toBeGreaterThan(0);
    }
  });

  it("every entry declares a route slot for every surface", () => {
    for (const e of NAV_ENTRIES) {
      for (const s of SURFACES) {
        expect(e.routes).toHaveProperty(s);
      }
    }
  });

  it("non-null routes are absolute paths", () => {
    for (const e of NAV_ENTRIES) {
      for (const s of SURFACES) {
        const r = e.routes[s];
        if (r !== null) expect(r.startsWith("/")).toBe(true);
      }
    }
  });

  it("scope is one of the allowed values", () => {
    for (const e of NAV_ENTRIES) {
      expect(["member", "admin"]).toContain(e.scope);
    }
  });

  it("group is one of the allowed values", () => {
    for (const e of NAV_ENTRIES) {
      expect(["workspace", "growth", "deliverability", "account"]).toContain(
        e.group,
      );
    }
  });

  it("keyboard shortcuts (when present) are unique", () => {
    const kbds = NAV_ENTRIES.map((e) => e.kbd).filter(
      (k): k is string => typeof k === "string",
    );
    expect(new Set(kbds).size).toBe(kbds.length);
  });

  it("routes are unique within each surface", () => {
    for (const s of SURFACES) {
      const routes = NAV_ENTRIES.map((e) => e.routes[s]).filter(
        (r): r is string => r !== null,
      );
      expect(new Set(routes).size).toBe(routes.length);
    }
  });
});

describe("labelFor / shortLabelFor", () => {
  it("returns the canonical label, killing per-surface drift", () => {
    // web "Overview" / desktop "Dashboard" / mobile "Home" all reconcile here.
    expect(labelFor("dashboard")).toBe("Dashboard");
    expect(labelFor("subscribers")).toBe("Subscribers");
  });
  it("shortLabel falls back to label when unset", () => {
    expect(shortLabelFor("subscribers")).toBe("People");
    expect(shortLabelFor("sequences")).toBe("Sequences"); // no shortLabel
  });
  it("returns undefined for unknown keys", () => {
    expect(labelFor("nope")).toBeUndefined();
    expect(shortLabelFor("nope")).toBeUndefined();
  });
});

describe("navForSurface", () => {
  it("returns only entries the surface exposes", () => {
    for (const s of SURFACES) {
      const list = navForSurface(s);
      expect(list.length).toBeGreaterThan(0);
      for (const e of list) expect(entryExposesSurface(e, s)).toBe(true);
    }
  });

  it("preserves canonical manifest order", () => {
    const web = navForSurface("web");
    const orderInManifest = NAV_ENTRIES.filter((e) => web.includes(e));
    expect(web).toEqual(orderInManifest);
  });

  it("mobile primary nav is the lean tab set, not the full surface", () => {
    const mobile = navForSurface("mobile").map((e) => e.key);
    expect(mobile).toContain("dashboard");
    expect(mobile).toContain("approvals");
    // Forms/Templates are web/desktop-only chrome — not mobile primary nav.
    expect(mobile).not.toContain("forms");
    expect(mobile).not.toContain("templates");
  });

  it("scope filtering hides admin entries from members", () => {
    const memberWeb = navForSurface("web", { scope: "member" }).map(
      (e) => e.key,
    );
    const adminWeb = navForSurface("web", { scope: "admin" }).map((e) => e.key);
    expect(memberWeb).not.toContain("billing"); // admin-scoped
    expect(adminWeb).toContain("billing");
    // member view is a strict subset of the admin view.
    for (const k of memberWeb) expect(adminWeb).toContain(k);
  });

  it("re-surfaces the orphaned Analytics page on web", () => {
    // The audit's headline orphan: shipped on web, missing from web's sidebar.
    expect(navForSurface("web").map((e) => e.key)).toContain("analytics");
    expect(routeFor("analytics", "web")).toBe("/app/analytics");
  });
});

describe("routeFor", () => {
  it("returns the surface-specific path", () => {
    expect(routeFor("dashboard", "mobile")).toBe("/(tabs)/dashboard");
    expect(routeFor("dashboard", "web")).toBe("/app");
  });
  it("returns null when a surface does not expose the entry", () => {
    expect(routeFor("forms", "mobile")).toBeNull();
    expect(routeFor("lists", "mobile")).toBeNull();
  });

  it("points web audit navigation at the shipped settings page", () => {
    expect(routeFor("audit", "web")).toBe("/app/settings/audit");
  });
  it("maps the authenticated archive surface across web and desktop", () => {
    expect(routeFor("archive", "web")).toBe("/app/archive-settings");
    expect(routeFor("archive", "desktop")).toBe("/app/archive");
    expect(getEntry("archive")?.scope).toBe("member");
  });
  it("returns null for unknown keys", () => {
    expect(routeFor("nope", "web")).toBeNull();
  });

  it("approvals web route is the standalone inbox, not a /settings child", () => {
    // Regression: the manifest claimed /app/settings/approvals, which has never
    // existed in apps/web. The real page is apps/web/src/app/(dashboard)/app/approvals.
    expect(routeFor("approvals", "web")).toBe("/app/approvals");
    expect(routeFor("approvals", "web")).not.toBe("/app/settings/approvals");
  });

  it("only deliberate settings concepts use nested /app/settings routes", () => {
    // Guard against re-introducing dead /settings-nested routes for entries
    // that actually ship as top-level /app pages. The only legitimate
    // /app/settings route is Settings itself.
    for (const e of NAV_ENTRIES) {
      const web = e.routes.web;
      if (web === null) continue;
      if (e.key === "settings" || e.key === "audit") continue;
      expect(web.startsWith("/app/settings")).toBe(false);
    }
  });
});

describe("getEntry / entriesInGroup", () => {
  it("getEntry round-trips by key", () => {
    for (const e of NAV_ENTRIES) {
      expect(getEntry(e.key)).toBe(e);
    }
  });
  it("entriesInGroup returns only that group, in order", () => {
    const account = entriesInGroup("account");
    expect(account.length).toBeGreaterThan(0);
    for (const e of account) expect(e.group).toBe("account");
  });
  it("every entry is reachable through exactly one group bucket", () => {
    const groups: Array<Parameters<typeof entriesInGroup>[0]> = [
      "workspace",
      "growth",
      "deliverability",
      "account",
    ];
    const counted = groups.flatMap((g) => entriesInGroup(g));
    expect(counted.length).toBe(NAV_ENTRIES.length);
  });
});

describe("SURFACES", () => {
  it("matches the route slots every entry declares", () => {
    const fromRoutes = new Set<Surface>();
    for (const e of NAV_ENTRIES)
      for (const s of Object.keys(e.routes) as Surface[]) fromRoutes.add(s);
    expect([...fromRoutes].sort()).toEqual([...SURFACES].sort());
  });
});
