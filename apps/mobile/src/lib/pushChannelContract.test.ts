/**
 * The Android notification-channel id is a wire contract between the Go sender
 * and this app: the server stamps `channelId` on every push, and Android
 * silently DROPS a notification whose channel the device never created. There
 * is no shared package between Go and TypeScript here, so the two mappings are
 * held together by this test — it parses the Go switch and asserts it agrees,
 * event for event, with the manifest-derived mapping the client registers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NOTIFICATIONS } from "@postwave/notifications";
import { describe, expect, it } from "vitest";

import {
  LEGACY_PUSH_CHANNEL_ID,
  androidPushChannels,
  pushChannelIdForEvent,
} from "./pushChannels";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), "../..", path), "utf8");
}

/**
 * Parse `androidChannelForEvent` out of the Go source into an event → channel
 * map. Deliberately a narrow parser over a known-shaped switch: if the function
 * is refactored into something this cannot read, the test fails loudly rather
 * than silently passing on an empty map.
 */
function goChannelMap(source: string): Record<string, string> {
  const fn = source.split("func androidChannelForEvent(")[1];
  expect(fn, "androidChannelForEvent not found in notification.go").toBeTruthy();
  const body = (fn ?? "").split("\n}")[0] ?? "";
  const map: Record<string, string> = {};
  // `case "a", "b":\n\t\treturn "channel"` — cases may wrap across lines.
  const caseRe = /case\s+([^:]+):\s*\n\s*return\s+"([a-z]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = caseRe.exec(body)) !== null) {
    const events = [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (m) => m[1] as string,
    );
    for (const event of events) map[event] = match[2] as string;
  }
  return map;
}

describe("android push channel contract (mobile ↔ Go sender)", () => {
  const source = repoFile("apps/api/internal/mobilepush/notification.go");
  const goMap = goChannelMap(source);

  it("parses a non-trivial mapping out of the Go sender", () => {
    expect(Object.keys(goMap).length).toBe(Object.keys(NOTIFICATIONS).length);
  });

  it("agrees with the client for every manifest event", () => {
    for (const event of Object.keys(NOTIFICATIONS)) {
      expect(goMap[event], `Go sender has no channel for ${event}`).toBe(
        pushChannelIdForEvent(event),
      );
    }
  });

  it("only names channels the client actually registers", () => {
    const registered = new Set(androidPushChannels().map((c) => c.id));
    for (const [event, channel] of Object.entries(goMap)) {
      expect(
        registered.has(channel),
        `${event} → "${channel}" is not a registered channel`,
      ).toBe(true);
    }
  });

  it("keeps the legacy channel as the Go fallback", () => {
    expect(source).toContain(`legacyAndroidChannel = "${LEGACY_PUSH_CHANNEL_ID}"`);
    expect(source).toContain("return legacyAndroidChannel");
  });

  it("no longer hardcodes a single channel on the delivery message", () => {
    const sender = repoFile("apps/api/internal/mobilepush/sender.go");
    // Whitespace-tolerant: gofmt re-pads struct literals whenever a field is
    // added, and a test that fails on alignment teaches people to stop
    // trusting it. The property is "the channel is derived from the event".
    expect(sender).toMatch(
      /ChannelID:\s+androidChannelForEvent\(n\.EventType\)/u,
    );
    expect(sender).not.toMatch(/ChannelID:\s+"default"/u);
  });
});

/**
 * NATIVE-V#1 — the iOS half of the same wire contract, and the half this app
 * genuinely cannot see. Interruption level is set by the SENDER on a remote
 * push; there is no client-side equivalent, so mobile has no way to notice that
 * the field went missing except by reading the Go source. Without it every
 * notification sits at the system default and a Focus mode silences an approval
 * as reliably as a campaign-open ping.
 */
describe("ios interruption level (sender-owned, client-unobservable)", () => {
  const sender = repoFile("apps/api/internal/mobilepush/sender.go");
  const notification = repoFile("apps/api/internal/mobilepush/notification.go");

  it("puts an interruption level on every delivery", () => {
    expect(sender).toMatch(
      /InterruptionLevel\s+string\s+`json:"interruptionLevel,omitempty"`/u,
    );
    expect(sender).toMatch(
      /InterruptionLevel:\s+interruptionLevelForEvent\(n\.EventType\)/u,
    );
  });

  it("marks the approval push time-sensitive — the flow the product is sold on", () => {
    const fn = notification.split("func interruptionLevelForEvent(")[1] ?? "";
    const body = fn.split("\n}")[0] ?? "";
    expect(body).toContain('"approval.requested"');
    expect(body).toContain("interruptionTimeSensitive");
  });

  it("never asks for the critical level", () => {
    // `critical` bypasses the ringer switch and requires an Apple-granted
    // entitlement this app does not hold.
    expect(notification).not.toContain('return "critical"');
    expect(notification).not.toContain("interruptionCritical");
  });
});
