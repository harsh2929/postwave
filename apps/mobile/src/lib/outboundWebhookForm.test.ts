import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  OUTBOUND_WEBHOOK_EVENT_FALLBACK,
  parseEventCatalog,
  resolveEventCatalog,
  validateWebhookUrl,
} from "./outboundWebhookForm";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), "../..", path), "utf8");
}

describe("outbound webhook event catalog", () => {
  it("matches the server's AllowedEvents exactly (the list that had already drifted)", () => {
    const go = repoFile(
      "apps/api/internal/outbound_webhooks/outbound_webhooks.go",
    );
    const block = /var AllowedEvents = \[\]string\{([\s\S]*?)\n\}/.exec(go);
    expect(block?.[1]).toBeTruthy();
    const body = block?.[1] ?? "";

    // Entries are a mix of string literals and Go constants; resolve both.
    const constants: Record<string, string> = {};
    for (const m of go.matchAll(/(Event[A-Za-z]+)\s*=\s*"([^"]+)"/g)) {
      const [, name, value] = m;
      if (name && value) constants[name] = value;
    }
    const serverEvents: string[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim().replace(/,$/, "");
      if (!trimmed || trimmed.startsWith("//")) continue;
      const literal = /^"([^"]+)"$/.exec(trimmed);
      if (literal?.[1]) {
        serverEvents.push(literal[1]);
        continue;
      }
      const named = constants[trimmed];
      if (named) serverEvents.push(named);
    }

    expect(serverEvents.length).toBeGreaterThan(0);
    // The two the old 7-item client constant was missing.
    expect(serverEvents).toContain("subscriber.unsubscribed");
    expect(serverEvents).toContain("list.subscriber.added");
    expect([...OUTBOUND_WEBHOOK_EVENT_FALLBACK].sort()).toEqual(
      [...serverEvents].sort(),
    );
  });

  it("reads the documented {events:[{event_type}]} envelope", () => {
    expect(
      parseEventCatalog({
        events: [
          { event_type: "campaign.sent", sample_payload: {} },
          { event_type: "bounce.received" },
        ],
      }),
    ).toEqual(["campaign.sent", "bounce.received"]);
  });

  it("accepts a bare array of strings and de-duplicates", () => {
    expect(parseEventCatalog(["a", "b", "a", " b "])).toEqual(["a", "b"]);
  });

  it("returns nothing for junk rather than inventing events", () => {
    expect(parseEventCatalog(null)).toEqual([]);
    expect(parseEventCatalog({ events: "nope" })).toEqual([]);
    expect(parseEventCatalog([{ nope: 1 }, 4, null])).toEqual([]);
  });

  it("falls back to the shipped list when the server answered with nothing", () => {
    expect(resolveEventCatalog(undefined)).toEqual([
      ...OUTBOUND_WEBHOOK_EVENT_FALLBACK,
    ]);
    expect(resolveEventCatalog({ events: [] })).toEqual([
      ...OUTBOUND_WEBHOOK_EVENT_FALLBACK,
    ]);
  });

  it("prefers the server catalog when it has entries the client has never heard of", () => {
    expect(resolveEventCatalog({ events: [{ event_type: "brand.new" }] })).toEqual(
      ["brand.new"],
    );
  });
});

describe("validateWebhookUrl", () => {
  it("rejects an empty value", () => {
    expect(validateWebhookUrl("   ")).toEqual({
      ok: false,
      message: "Enter the destination URL.",
    });
  });

  it("rejects a bare host with no scheme and says what is missing", () => {
    const res = validateWebhookUrl("example.com/hooks");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("scheme");
  });

  it("rejects a mistyped scheme", () => {
    expect(validateWebhookUrl("htp://example.com").ok).toBe(false);
  });

  it("rejects non-http schemes outright", () => {
    expect(validateWebhookUrl("mailto:ops@example.com").ok).toBe(false);
    expect(validateWebhookUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateWebhookUrl("ftp://example.com/hook").ok).toBe(false);
  });

  it("accepts a normal https URL with no warning", () => {
    expect(validateWebhookUrl(" https://example.com/webhooks/postwave ")).toEqual({
      ok: true,
      url: "https://example.com/webhooks/postwave",
    });
  });

  it("warns but allows plain http", () => {
    const res = validateWebhookUrl("http://example.com/hook");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warning).toContain("plain http");
  });

  it("warns but allows a private host — a tunnel is a legitimate destination", () => {
    for (const host of [
      "https://localhost:3000/h",
      "https://127.0.0.1/h",
      "https://10.0.0.4/h",
      "https://192.168.1.9/h",
      "https://172.20.3.4/h",
      "https://box.local/h",
    ]) {
      const res = validateWebhookUrl(host);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.warning).toContain("private");
    }
  });

  it("does not treat 172.32.x as private", () => {
    const res = validateWebhookUrl("https://172.32.0.1/h");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warning).toBeUndefined();
  });
});
