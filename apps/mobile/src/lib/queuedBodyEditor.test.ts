import { describe, expect, it } from "vitest";

import {
  buildBodyFromFields,
  deriveFlatFields,
  parseRawBody,
  stringifyBody,
  validateEditedBody,
} from "./queuedBodyEditor";

describe("deriveFlatFields", () => {
  it("turns a flat string/number/boolean object into typed rows in key order", () => {
    expect(deriveFlatFields({ name: "VIP", weight: 2.5, pii: false })).toEqual([
      { key: "name", type: "string", raw: "VIP" },
      { key: "weight", type: "number", raw: "2.5" },
      { key: "pii", type: "boolean", raw: false },
    ]);
  });

  it("declines nested, empty, null-valued, array and non-object bodies", () => {
    expect(deriveFlatFields({ steps: [{ a: 1 }] })).toBeNull();
    expect(deriveFlatFields({ group_id: null })).toBeNull();
    expect(deriveFlatFields({})).toBeNull();
    expect(deriveFlatFields([])).toBeNull();
    expect(deriveFlatFields("x")).toBeNull();
    expect(deriveFlatFields({ n: Number.NaN })).toBeNull();
  });
});

describe("buildBodyFromFields", () => {
  it("preserves each field's original type", () => {
    expect(
      buildBodyFromFields([
        { key: "name", type: "string", raw: " VIP " },
        { key: "weight", type: "number", raw: " 3 " },
        { key: "pii", type: "boolean", raw: true },
      ]),
    ).toEqual({ ok: true, body: { name: " VIP ", weight: 3, pii: true } });
  });

  it("names the field whose number no longer parses", () => {
    expect(
      buildBodyFromFields([{ key: "weight", type: "number", raw: "heavy" }]),
    ).toEqual({ ok: false, error: '"weight" must be a number (got "heavy").' });
    expect(buildBodyFromFields([{ key: "weight", type: "number", raw: "" }]).ok).toBe(false);
  });
});

describe("parseRawBody / stringifyBody", () => {
  it("round-trips JSON, treats blank as no body, and reports invalid JSON", () => {
    expect(parseRawBody("  ")).toEqual({ ok: true, body: undefined });
    expect(parseRawBody('{"a":1}')).toEqual({ ok: true, body: { a: 1 } });
    const bad = parseRawBody("{a:1}");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^Not valid JSON: /);
    expect(stringifyBody({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(stringifyBody(undefined)).toBe("");
  });
});

describe("validateEditedBody", () => {
  it("refuses an entity-write edit that has become an online-only action", () => {
    const campaign = { kind: "entity_write" as const, method: "PATCH" as const, path: "/api/v1/campaigns/c1" };
    expect(validateEditedBody(campaign, { subject: "Hi" })).toBeNull();
    expect(validateEditedBody(campaign, { status: "scheduled" })).toMatch(/online-only/);
    expect(validateEditedBody(campaign, { scheduled_at: "2026-09-02T10:00:00Z" })).toMatch(/online-only/);
    const form = { kind: "entity_write" as const, method: "PATCH" as const, path: "/api/v1/forms/f1" };
    expect(validateEditedBody(form, { status: "published" })).toMatch(/online-only/);
    const subscriber = { kind: "entity_write" as const, method: "PATCH" as const, path: "/api/v1/subscribers/s1" };
    expect(validateEditedBody(subscriber, { status: "unsubscribed" })).toMatch(/online-only/);
    // The whole subscriber PATCH is online-only (it needs If-Match), so even a
    // harmless profile field cannot be saved back into the queue.
    expect(validateEditedBody(subscriber, { name: "Ada" })).toMatch(/online-only/);
  });

  it("refuses an entity-write path that is not on the offline allowlist at all", () => {
    expect(
      validateEditedBody(
        { kind: "entity_write", method: "POST", path: "/api/v1/campaigns/c1/send" },
        {},
      ),
    ).toMatch(/online-only/);
  });

  it("leaves the bespoke executors to their own rebuild rules", () => {
    expect(
      validateEditedBody(
        { kind: "campaign_update", method: "PATCH", path: "/api/v1/campaigns/c1" },
        { anything: true },
      ),
    ).toBeNull();
    expect(
      validateEditedBody(
        { kind: "sequence_create", method: "POST", path: "/api/v1/voice/sequences" },
        { name: "x" },
      ),
    ).toBeNull();
  });
});
