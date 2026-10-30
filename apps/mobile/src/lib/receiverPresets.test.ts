/**
 * receiverPresets — the field-mapping half of the receiver preset gallery.
 *
 * The gallery is a CONVENIENCE that rewrites a draft the operator is looking
 * at, so every test here is about what it is NOT allowed to do to that draft:
 * invent a destination, eat a typed description, send a topic the deployment
 * does not offer, or silently drop a selection. The preset DATA is checked
 * against desktop's own module by reading it, not by restating it — a table
 * copied into the test proves only that two copies agree with each other.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RECEIVER_PRESETS,
  RECEIVER_PRESET_SIGNING_NOTE,
  applyReceiverPreset,
  canonicalPresetEvents,
  receiverPresetByName,
  receiverPresetGalleryAccess,
  receiverPresetNotes,
  type ReceiverPreset,
} from "./receiverPresets";

/** The full 8-topic catalog is irrelevant here; these two are what presets use. */
const CATALOG = [
  "campaign.sent",
  "subscriber.added",
  "subscriber.removed",
  "audit.created",
];

function preset(name: string): ReceiverPreset {
  const found = receiverPresetByName(name);
  if (!found) throw new Error(`no preset named ${name}`);
  return found;
}

describe("the preset table", () => {
  it("carries every desktop receiver, with desktop's own copy", () => {
    // Read desktop's module rather than restating it: a hand-copied
    // expectation would pass even after desktop changed a URL hint, which is
    // the exact drift this gallery exists to avoid.
    const source = readFileSync(
      resolve(
        __dirname,
        "../../../desktop/src/components/webhooks/receiver-presets.ts",
      ),
      "utf8",
    );
    for (const entry of RECEIVER_PRESETS) {
      expect(
        source.includes(JSON.stringify(entry.urlPlaceholder)),
        `${entry.name} url hint`,
      ).toBe(true);
      expect(
        source.includes(JSON.stringify(entry.description)),
        `${entry.name} description`,
      ).toBe(true);
      // helpText contains typographic quotes/arrows; compare the inner text.
      expect(source.includes(entry.helpText.slice(0, 40)), entry.name).toBe(
        true,
      );
    }
    // Desktop's Record has one key per preset; count them the same way.
    const desktopNames = [...source.matchAll(/^\s{4}name: "([^"]+)",$/gm)].map(
      (m) => m[1],
    );
    expect(new Set(desktopNames)).toEqual(
      new Set(RECEIVER_PRESETS.map((p) => p.name)),
    );
  });

  it("keeps 'Your own server' last — it is the fallback, not a suggestion", () => {
    expect(RECEIVER_PRESETS[RECEIVER_PRESETS.length - 1]?.name).toBe(
      "Your own server",
    );
  });

  it("never ships a preset whose urlPlaceholder could pass as a real URL", () => {
    // Every hint carries an ellipsis or an obviously-fake host, which is why
    // rule 1 can afford to leave the URL field to the operator.
    for (const entry of RECEIVER_PRESETS) {
      expect(
        entry.urlPlaceholder.includes("…") ||
          entry.urlPlaceholder.includes("your-domain.com"),
        entry.name,
      ).toBe(true);
    }
  });

  it("states the signing convention the mobile create body actually gets", () => {
    // api/settings.ts OutboundWebhookCreateInput carries no `algorithm`, and
    // the store defaults an omitted one to hmac_sha256 — so the sentence must
    // say HMAC and must say it is permanent.
    expect(RECEIVER_PRESET_SIGNING_NOTE).toContain("HMAC-SHA256");
    expect(RECEIVER_PRESET_SIGNING_NOTE).toContain("can't be changed later");
  });

  it("resolves a preset by name and refuses anything else", () => {
    expect(receiverPresetByName("n8n")?.urlPlaceholder).toBe(
      "https://n8n.example.com/webhook/…",
    );
    expect(receiverPresetByName("Slack")).toBeNull();
    expect(receiverPresetByName("")).toBeNull();
    expect(receiverPresetByName(null)).toBeNull();
    expect(receiverPresetByName(undefined)).toBeNull();
  });
});

describe("canonicalPresetEvents", () => {
  it("drops topics the catalog does not offer instead of sending them", () => {
    expect(
      canonicalPresetEvents(["campaign.sent", "retired.topic"], CATALOG),
    ).toEqual(["campaign.sent"]);
  });

  it("follows the preset's order, not the catalog's, and de-duplicates", () => {
    expect(
      canonicalPresetEvents(
        ["subscriber.added", "campaign.sent", "subscriber.added"],
        CATALOG,
      ),
    ).toEqual(["subscriber.added", "campaign.sent"]);
  });

  it("returns nothing when the catalog is empty", () => {
    expect(canonicalPresetEvents(["campaign.sent"], [])).toEqual([]);
  });
});

describe("applyReceiverPreset — rule 1: a preset never supplies a URL", () => {
  it("leaves a URL the operator already typed exactly as it was", () => {
    const applied = applyReceiverPreset(
      { url: "https://mine.example/hook", description: "", events: [] },
      preset("Zapier"),
      CATALOG,
    );
    expect(applied.draft.url).toBe("https://mine.example/hook");
  });

  it("leaves the URL EMPTY rather than filling it with the hint", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "", events: [] },
      preset("Zapier"),
      CATALOG,
    );
    expect(applied.draft.url).toBe("");
    expect(applied.draft.url).not.toBe(preset("Zapier").urlPlaceholder);
  });
});

describe("applyReceiverPreset — rule 2: a typed description survives", () => {
  it("fills an empty description", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "", events: [] },
      preset("Discord"),
      CATALOG,
    );
    expect(applied.draft.description).toBe("Discord — created via gallery");
    expect(applied.keptDescription).toBe(false);
  });

  it("fills a whitespace-only description — that is not a label", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "   ", events: [] },
      preset("Discord"),
      CATALOG,
    );
    expect(applied.draft.description).toBe("Discord — created via gallery");
    expect(applied.keptDescription).toBe(false);
  });

  it("keeps a description the operator typed, and says so", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "Ops alerting hook", events: [] },
      preset("Discord"),
      CATALOG,
    );
    expect(applied.draft.description).toBe("Ops alerting hook");
    expect(applied.keptDescription).toBe(true);
    expect(receiverPresetNotes(applied)).toContain(
      "Kept the description you had already written — a template only fills an empty one.",
    );
  });

  it("replaces ANOTHER preset's boilerplate — switching receivers renames", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "Zapier — created via gallery", events: [] },
      preset("n8n"),
      CATALOG,
    );
    expect(applied.draft.description).toBe("n8n — created via gallery");
    expect(applied.keptDescription).toBe(false);
  });
});

describe("applyReceiverPreset — rule 3: topics go through the catalog", () => {
  it("selects the preset defaults this deployment offers", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "", events: [] },
      preset("Make (Integromat)"),
      CATALOG,
    );
    expect(applied.draft.events).toEqual(["campaign.sent", "subscriber.added"]);
    expect(applied.dropped).toEqual([]);
    expect(receiverPresetNotes(applied)).toEqual([]);
  });

  it("names the topics this workspace does not offer instead of sending them", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "", events: [] },
      preset("Zapier"),
      ["campaign.sent"],
    );
    expect(applied.draft.events).toEqual(["campaign.sent"]);
    expect(applied.dropped).toEqual(["subscriber.added"]);
    expect(receiverPresetNotes(applied)).toContain(
      "This workspace doesn't offer subscriber.added, so it was left unselected.",
    );
  });

  it("pluralises the dropped-topic sentence", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "", events: ["audit.created"] },
      preset("Zapier"),
      ["audit.created"],
    );
    expect(applied.dropped).toEqual(["campaign.sent", "subscriber.added"]);
    expect(receiverPresetNotes(applied)).toContain(
      "This workspace doesn't offer campaign.sent and subscriber.added, so they were left unselected.",
    );
  });

  it("keeps the existing selection when NOTHING survives — a stale row beats an empty one", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "", events: ["audit.created"] },
      preset("Zapier"),
      [],
    );
    expect(applied.draft.events).toEqual(["audit.created"]);
    // Nothing was taken away, so there is nothing to apologise for.
    expect(applied.replacedEvents).toEqual([]);
  });
});

describe("applyReceiverPreset — a replaced selection is named, not hidden", () => {
  it("reports topics that were ticked before the apply and are not after it", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "", events: ["audit.created"] },
      preset("Zapier"),
      CATALOG,
    );
    expect(applied.draft.events).toEqual(["campaign.sent", "subscriber.added"]);
    expect(applied.replacedEvents).toEqual(["audit.created"]);
    expect(receiverPresetNotes(applied)).toContain(
      "Replaced your event selection — audit.created is no longer selected. Tap the chips below to put it back.",
    );
  });

  it("says nothing when the preset only ADDS to what was selected", () => {
    const applied = applyReceiverPreset(
      { url: "", description: "", events: ["campaign.sent"] },
      preset("Zapier"),
      CATALOG,
    );
    expect(applied.replacedEvents).toEqual([]);
    expect(receiverPresetNotes(applied)).toEqual([]);
  });

  it("pluralises, de-duplicates and keeps the operator's order", () => {
    const applied = applyReceiverPreset(
      {
        url: "",
        description: "",
        events: ["subscriber.removed", "audit.created", "subscriber.removed"],
      },
      preset("Zapier"),
      CATALOG,
    );
    expect(applied.replacedEvents).toEqual([
      "subscriber.removed",
      "audit.created",
    ]);
    expect(receiverPresetNotes(applied)).toContain(
      "Replaced your event selection — subscriber.removed and audit.created are no longer selected. Tap the chips below to put them back.",
    );
  });

  it("does not mutate the draft it was handed", () => {
    const events = ["audit.created"];
    const current = { url: "https://x.test/h", description: "Mine", events };
    applyReceiverPreset(current, preset("Zapier"), CATALOG);
    expect(events).toEqual(["audit.created"]);
    expect(current.description).toBe("Mine");
  });
});

describe("receiverPresetGalleryAccess", () => {
  it("offers the templates to a session that can actually create", () => {
    expect(
      receiverPresetGalleryAccess({ hasAdminRole: true, apiKeyMode: false }),
    ).toEqual({ enabled: true });
  });

  it("withholds them below admin, with the role named", () => {
    const access = receiverPresetGalleryAccess({
      hasAdminRole: false,
      apiKeyMode: false,
    });
    expect(access.enabled).toBe(false);
    expect(access.reason).toBe(
      "Creating an outbound webhook needs an owner or admin role, so these receiver templates aren't offered.",
    );
  });

  it("withholds them under an API key — that reason is more specific than the role one", () => {
    const access = receiverPresetGalleryAccess({
      hasAdminRole: false,
      apiKeyMode: true,
    });
    expect(access.enabled).toBe(false);
    expect(access.reason).toContain("API key");
  });

  it("never returns enabled without a reason, or disabled without one", () => {
    for (const hasAdminRole of [true, false]) {
      for (const apiKeyMode of [true, false]) {
        const access = receiverPresetGalleryAccess({
          hasAdminRole,
          apiKeyMode,
        });
        if (access.enabled) expect(access.reason).toBeUndefined();
        else expect(access.reason?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
