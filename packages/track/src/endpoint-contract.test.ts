// SPDX-License-Identifier: AGPL-3.0-only
//
// The tracker must speak the endpoint's actual language.
//
// This package is the browser producer for POST /api/public/track/event. Its
// consumers are, by design, OUTSIDE this repository — a site owner drops it
// into their own pages — so "zero importers here" says nothing about whether it
// works, and the usual dead-code check does not apply to it.
//
// What DOES apply is drift. Nothing in this repo imports the package, so no
// build breaks when the Go handler renames a field; the tracker would keep
// posting a body the endpoint silently ignores, and events would vanish with a
// 200. This reads the Go struct and asserts the wire names still match.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTracker } from "./index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const handlerPath = join(repoRoot, "apps/api/internal/publictrack/publictrack.go");

/** The json tag names on the endpoint's request struct. */
function endpointFields(): Set<string> {
  const source = readFileSync(handlerPath, "utf8");
  const start = source.indexOf("type eventInput struct {");
  expect(start, `eventInput struct not found in ${handlerPath}`).toBeGreaterThan(-1);
  const end = source.indexOf("}", start);
  const body = source.slice(start, end);
  const names = new Set<string>();
  for (const match of body.matchAll(/json:"([a-z_]+)/g)) {
    const [, name] = match;
    // The group is always populated on a successful match, so this cannot fire
    // in practice. Throwing rather than skipping keeps it that way: a silently
    // dropped tag would shrink the field set and make the drift assertions
    // below pass against a handler they no longer describe.
    if (name === undefined) {
      throw new Error(`unparsable json tag ${match[0]} in ${handlerPath}`);
    }
    names.add(name);
  }
  return names;
}

describe("the tracker's payload matches the endpoint it posts to", () => {
  it("reads the handler", () => {
    // Guard the guard: an empty parse would make every assertion below vacuous.
    expect(endpointFields().size).toBeGreaterThanOrEqual(6);
  });

  it("sends only field names the endpoint declares", async () => {
    const fields = endpointFields();
    let sent: Record<string, unknown> = {};

    const tracker = createTracker({
      endpoint: "https://example.test/api/public/track/event",
      idGenerator: () => "fixed-id",
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    await tracker.track({
      email: "person@example.test",
      eventName: "Viewed Pricing",
      eventType: "page_view",
      externalId: "ext-1",
      properties: { plan: "pro" },
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });

    const unknownKeys = Object.keys(sent).filter((k) => !fields.has(k));
    expect(
      unknownKeys,
      `the tracker posts ${JSON.stringify(unknownKeys)}, which the endpoint's ` +
        `eventInput does not declare. Nothing in this repo imports this package, ` +
        `so no build would have broken — the events would simply stop arriving, ` +
        `with a 200.`,
    ).toEqual([]);

    // And every field a caller supplied actually made it onto the wire. A
    // tracker that silently drops properties is worse than one that fails.
    for (const required of ["email", "event_name", "event_type", "external_id", "properties", "occurred_at", "source_event_id"]) {
      expect(sent[required], `${required} was not sent`).toBeDefined();
    }
  });
});
