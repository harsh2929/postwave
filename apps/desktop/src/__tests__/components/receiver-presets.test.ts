// Receiver presets (full-surface wiring #60): Discord + Microsoft
// Teams join the gallery presets. Every preset must carry an https
// URL placeholder, sensible default events drawn from the real event
// catalog, and non-empty docs hints.
//
// D12#2: default events MUST be drawn from the `webhooks` subsystem
// catalog (ALL_EVENTS mirrors webhooks.AllEvents) — the create handler
// rejects anything else with 400 "unknown event". This set is kept in
// sync with ReceiverPresetDialog.ALL_EVENTS.

import { describe, expect, it } from "vitest";

import {
  ALL_EVENTS,
  canonicalPresetEvents,
} from "../../components/webhooks/ReceiverPresetDialog";
import { RECEIVER_PRESETS } from "../../components/webhooks/receiver-presets";

const KNOWN_EVENTS = new Set(ALL_EVENTS);

describe("RECEIVER_PRESETS", () => {
  it("includes the Discord and Microsoft Teams presets (#60)", () => {
    expect(Object.keys(RECEIVER_PRESETS)).toEqual(
      expect.arrayContaining(["Discord", "Microsoft Teams"]),
    );
  });

  it("Discord preset points at the Discord webhook URL shape", () => {
    const p = RECEIVER_PRESETS["Discord"];
    expect(p?.urlPlaceholder).toContain("https://discord.com/api/webhooks/");
    expect(p?.helpText).toContain("Integrations");
    expect(p?.description.length).toBeGreaterThan(0);
  });

  it("Teams preset points at the Workflows request URL and mentions the legacy connector", () => {
    const p = RECEIVER_PRESETS["Microsoft Teams"];
    expect(p?.urlPlaceholder.startsWith("https://")).toBe(true);
    expect(p?.helpText).toContain("Workflows");
    expect(p?.helpText).toContain("webhook.office.com");
  });

  it("every preset (old and new) stays consistent: https placeholder, known default events, help text", () => {
    for (const [name, p] of Object.entries(RECEIVER_PRESETS)) {
      expect(p.name, name).toBe(name);
      expect(p.urlPlaceholder.startsWith("https://"), name).toBe(true);
      const canonicalEvents = canonicalPresetEvents(p.defaultEvents);
      expect(
        canonicalEvents,
        `${name} uses only canonical event names`,
      ).toEqual(p.defaultEvents);
      expect(canonicalEvents.length, name).toBeGreaterThan(0);
      for (const ev of canonicalEvents) {
        expect(KNOWN_EVENTS.has(ev), `${name} event ${ev}`).toBe(true);
      }
      expect(p.helpText.length, name).toBeGreaterThan(0);
    }
  });
});
