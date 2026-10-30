// SPDX-License-Identifier: AGPL-3.0-only
//
// INTG-029: unit-tests for the connected-integrations merge/normalize core (the
// pure helpers behind useConnectedIntegrations). No rendering / no network.

import { describe, it, expect } from "vitest";

import {
  buildConnectedMap,
  normalizeStatus,
  toConnectedFromChat,
  toConnectedFromSurface,
  type ConnectedIntegration,
} from "@/lib/connected-integrations";

describe("normalizeStatus", () => {
  it("maps surface status strings to coarse states, case-insensitively", () => {
    expect(normalizeStatus("active")).toBe("connected");
    expect(normalizeStatus("Connected")).toBe("connected");
    expect(normalizeStatus("paused")).toBe("paused");
    expect(normalizeStatus("FAILED")).toBe("error");
    expect(normalizeStatus("error")).toBe("error");
    expect(normalizeStatus("weird")).toBe("unknown");
    expect(normalizeStatus("")).toBe("unknown");
  });
});

describe("toConnectedFromChat", () => {
  it("injects the provider (chat rows carry none) and maps enabled→status", () => {
    const out = toConnectedFromChat(
      [
        { id: "s1", enabled: true },
        { id: "s2", enabled: false },
      ],
      "slack",
    );
    expect(out).toEqual([
      { provider: "slack", surfaceKey: "chat", status: "connected", id: "s1" },
      { provider: "slack", surfaceKey: "chat", status: "paused", id: "s2" },
    ]);
  });
});

describe("toConnectedFromSurface", () => {
  it("carries the row provider and tags the surface key", () => {
    const out = toConnectedFromSurface(
      [{ provider: "salesforce", status: "active", id: "c1" }],
      "crm",
    );
    expect(out).toEqual([
      {
        provider: "salesforce",
        surfaceKey: "crm",
        status: "connected",
        id: "c1",
      },
    ]);
  });
});

describe("buildConnectedMap", () => {
  const row = (
    provider: string,
    status: ConnectedIntegration["status"],
    id: string,
  ): ConnectedIntegration => ({ provider, surfaceKey: "x", status, id });

  it("collapses multiple rows for one provider, connected wins", () => {
    const map = buildConnectedMap([
      row("mailchimp", "paused", "a"),
      row("mailchimp", "connected", "b"),
    ]);
    expect(map.size).toBe(1);
    expect(map.get("mailchimp")?.status).toBe("connected");
    expect(map.get("mailchimp")?.id).toBe("b");
  });

  it("keys by normalized provider so casing/punctuation variants collapse", () => {
    const map = buildConnectedMap([
      row("Google-Ads", "connected", "a"),
      row("google_ads", "connected", "b"),
    ]);
    expect(map.size).toBe(1);
    expect(map.has("googleads")).toBe(true);
  });

  it("keeps distinct providers separate and isolates empty sources", () => {
    // An empty (e.g. 403-denied) source contributes nothing but must not blank
    // the others.
    const map = buildConnectedMap([
      ...[],
      row("hubspot", "connected", "h"),
      row("klaviyo", "error", "k"),
    ]);
    expect(map.size).toBe(2);
    expect(map.get("hubspot")?.status).toBe("connected");
    expect(map.get("klaviyo")?.status).toBe("error");
  });
});
