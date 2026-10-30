import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITY_KEYS } from "@postwave/route-map";
import {
  CHANNELS,
  DEFAULT_NOTIFICATION,
  NOTIFICATIONS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  channelEligible,
  defaultEnabledEvents,
  eventsInCategory,
  getNotification,
  notificationForEvent,
} from "./index";

describe("manifest internal consistency", () => {
  it("keeps control bytes out of source that is bundled for Firefox", () => {
    const source = readFileSync(new URL("./helpers.ts", import.meta.url), "utf8");
    expect(source).not.toContain("\u0000");
  });

  it("each entry's key matches its event field", () => {
    for (const [key, def] of Object.entries(NOTIFICATIONS)) {
      expect(def.event).toBe(key);
    }
  });

  it("events are unique", () => {
    expect(new Set(NOTIFICATION_EVENTS).size).toBe(NOTIFICATION_EVENTS.length);
  });

  it("every entry has non-empty title and body templates", () => {
    for (const def of Object.values(NOTIFICATIONS)) {
      expect(def.titleTemplate.length).toBeGreaterThan(0);
      expect(def.bodyTemplate.length).toBeGreaterThan(0);
    }
  });

  it("every entry has at least one eligible channel, all valid", () => {
    for (const def of Object.values(NOTIFICATIONS)) {
      expect(def.channels.length).toBeGreaterThan(0);
      for (const c of def.channels) expect(CHANNELS).toContain(c);
    }
  });

  it("category is one of the allowed values", () => {
    // Pinned literally, not derived from NOTIFICATION_CATEGORIES: a new
    // category is a new Android channel and a new preferences row on every
    // client, so it must be a deliberate edit here rather than something that
    // arrives silently with a manifest entry.
    const allowed = [
      "security",
      "approvals",
      "billing",
      "deliverability",
      "integrations",
      "campaigns",
      "subscribers",
      "automations",
      "migrations",
      "forms",
    ];
    for (const def of Object.values(NOTIFICATIONS)) {
      expect(allowed).toContain(def.category);
    }
    expect([...NOTIFICATION_CATEGORIES].sort()).toEqual([...allowed].sort());
  });

  it("keeps the new-device alert default-on, content-light, and push eligible", () => {
    const signIn = NOTIFICATIONS["auth.new_device_sign_in"];
    expect(signIn).toMatchObject({
      category: "security",
      defaultEnabled: true,
      deepLinkEntity: null,
    });
    expect(signIn?.channels).toContain("push");
    expect(`${signIn?.titleTemplate} ${signIn?.bodyTemplate}`).not.toMatch(
      /cookie|verifier|device[_ -]?code|token=/iu,
    );
  });

  it("NOTIFICATION_CATEGORIES covers every category actually in use", () => {
    // The ordering list drives per-category UI and Android channel
    // registration. A category present in the manifest but missing here would
    // silently lose its channel — and Android drops a push whose channel does
    // not exist.
    const used = new Set(
      Object.values(NOTIFICATIONS).map((def) => def.category),
    );
    for (const category of used) {
      expect(NOTIFICATION_CATEGORIES).toContain(category);
    }
  });

  it("deepLinkEntity (when set) is a real route-map entity key", () => {
    for (const def of Object.values(NOTIFICATIONS)) {
      if (def.deepLinkEntity !== null) {
        expect(ENTITY_KEYS).toContain(def.deepLinkEntity);
      }
    }
  });

  it("matches the Go mobile-device allowlist and default policy", () => {
    const goSource = readFileSync(
      resolve(process.cwd(), "../..", "apps/api/internal/mobilepush/devices.go"),
      "utf8",
    );
    const block = goSource.match(
      /var allowedDeviceEvents = map\[string\]bool\{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(block).toBeDefined();

    const goEntries = Array.from(
      block?.matchAll(/^\s*"([^"]+)":\s*(true|false),$/gmu) ?? [],
      (match) => {
        const event = match[1];
        if (!event) throw new Error("Go mobile-push event match was empty");
        return [event, match[2] === "true"] as const;
      },
    ).sort(([left], [right]) => left.localeCompare(right));
    const manifestEntries = Object.values(NOTIFICATIONS)
      .filter((definition) => definition.channels.includes("push"))
      .map(
        (definition) =>
          [definition.event, definition.defaultEnabled] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right));

    expect(goEntries).toEqual(manifestEntries);
  });
});

describe("notificationForEvent — copy", () => {
  it("renders the canonical approval copy", () => {
    const n = notificationForEvent("approval.requested");
    expect(n.title).toBe("Approval needed");
    expect(n.body).toBe("A pending request is waiting for your decision.");
    expect(n.category).toBe("approvals");
    expect(n.defaultEnabled).toBe(true);
  });

  it("fills template placeholders from context fields", () => {
    const n = notificationForEvent("campaign.sent", {
      fields: { campaignName: "Summer Sale" },
    });
    expect(n.body).toBe("Summer Sale finished sending.");
  });

  it("drops a missing placeholder cleanly (no literal braces, no double space)", () => {
    const n = notificationForEvent("campaign.sent"); // no campaignName
    expect(n.body).not.toContain("{");
    expect(n.body).not.toContain("  ");
    expect(n.body).toBe("finished sending.");
  });

  it("falls back to the generic copy for unknown events", () => {
    const n = notificationForEvent("nope.unknown");
    expect(n.title).toBe("Moosewave update");
    expect(n.body).toBe("Open Moosewave for details.");
    expect(n.deepLink).toBeNull();
    expect(n.channels).toEqual(["push", "desktop", "web"]);
  });
});

describe("notificationForEvent — deep link (reuses route-map)", () => {
  it("builds moosewave:// + universal links from the entity + id", () => {
    const n = notificationForEvent("campaign.sent", { entityId: "cam_1" });
    expect(n.deepLinkEntity).toBe("campaign");
    expect(n.deepLink).toBe("moosewave://campaign/cam_1");
    expect(n.universalLink).toBe(
      "https://app.moosewave.com/app/campaigns/cam_1",
    );
  });

  it("omits the deep link when there is no id", () => {
    const n = notificationForEvent("campaign.sent");
    expect(n.deepLink).toBeNull();
    expect(n.universalLink).toBeNull();
  });

  it("omits the deep link for events without an entity target", () => {
    const n = notificationForEvent("migration.completed", { entityId: "mig_1" });
    expect(n.deepLinkEntity).toBeNull();
    expect(n.deepLink).toBeNull();
  });

  it("propagates route-map's null for unsafe ids (no malformed link)", () => {
    const n = notificationForEvent("subscriber.bounced", {
      entityId: "../sign-out",
    });
    expect(n.deepLink).toBeNull();
    expect(n.universalLink).toBeNull();
  });

  it("every entity-targeting event round-trips to a valid deep link", () => {
    for (const def of Object.values(NOTIFICATIONS)) {
      if (!def.deepLinkEntity) continue;
      const n = notificationForEvent(def.event, { entityId: "id_123" });
      expect(n.deepLink).toBe(`moosewave://${def.deepLinkEntity}/id_123`);
    }
  });
});

describe("channel eligibility + preferences", () => {
  it("channelEligible reflects the manifest", () => {
    expect(channelEligible("approval.requested", "web")).toBe(true);
    expect(channelEligible("approval.requested", "desktop")).toBe(true);
  });
  it("unknown events are eligible on every channel", () => {
    for (const c of CHANNELS) expect(channelEligible("nope", c)).toBe(true);
  });
  it("defaultEnabledEvents returns only default-on events", () => {
    const on = defaultEnabledEvents();
    expect(on).toContain("approval.requested");
    expect(on).not.toContain("campaign.opened"); // high-volume, opt-in
    for (const e of on) expect(getNotification(e)?.defaultEnabled).toBe(true);
  });
  it("eventsInCategory groups correctly", () => {
    const subs = eventsInCategory("subscribers");
    expect(subs).toContain("subscriber.bounced");
    for (const e of subs) expect(getNotification(e)?.category).toBe("subscribers");
  });
});

describe("inherited property names are not notification definitions", () => {
  // NOTIFICATIONS is a plain object literal, so it inherits from
  // Object.prototype. A bare `NOTIFICATIONS[event]` therefore returned the
  // Object CONSTRUCTOR for "constructor" — truthy — which skipped every
  // caller's `if (!def)` unknown-event fallback and threw on the next line.
  //
  // These names are not hypothetical input: the event string comes off a
  // server notification payload, and the unknown-event fallback exists
  // precisely so a build that does not recognise an event degrades instead of
  // crashing. It degraded for every unknown name except these.
  const INHERITED = [
    "constructor",
    "__proto__",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ];

  it.each(INHERITED)("getNotification(%j) is undefined", (name) => {
    expect(getNotification(name)).toBeUndefined();
  });

  it.each(INHERITED)("notificationForEvent(%j) renders the fallback", (name) => {
    const rendered = notificationForEvent(name);
    expect(rendered.title).toBe(DEFAULT_NOTIFICATION.title);
    expect(rendered.body).toBe(DEFAULT_NOTIFICATION.body);
    expect(rendered.defaultEnabled).toBe(false);
    expect(rendered.deepLink).toBeNull();
  });

  it.each(INHERITED)("channelEligible(%j) does not throw", (name) => {
    expect(() => channelEligible(name, "push")).not.toThrow();
  });

  it("still resolves a real event", () => {
    // Guard the guard: a lookup that returned undefined for EVERYTHING would
    // satisfy every assertion above.
    const known = defaultEnabledEvents()[0];
    expect(known, "no default-enabled events in the manifest").toBeTruthy();
    expect(getNotification(known!)).toBeDefined();
    expect(notificationForEvent(known!).title).not.toBe(DEFAULT_NOTIFICATION.title);
  });
});
