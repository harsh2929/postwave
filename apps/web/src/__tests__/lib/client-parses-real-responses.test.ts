// SPDX-License-Identifier: AGPL-3.0-only
//
// Feeds RECORDED SERVER RESPONSES through the real client functions and asserts
// the parse is not degenerate.
//
// WHY RECORDED, AND NOT A STUB. This suite already had 16 tests that stub
// fetch, and for this defect class they prove nothing: every stub body is a
// literal authored beside the client it tests, so when the server renames a
// field the stub and the client stay consistently wrong TOGETHER and the test
// still passes. Only a body that came from the server can break that symmetry.
//
// THE DEFECT THIS CATCHES, which shipped: ai-compose-api read `variants` from a
// response whose field is `subject_variants`. The value was undefined, the
// module's `?? []` turned it into an empty array, and the page reported
// "0 variants generated" forever — a model that appeared to produce nothing,
// caused entirely by a client reading the wrong key.
//
// That failure mode is invisible to a type-checker (the shapes are compatible)
// and invisible to clicking (the page renders fine). 48 of the 50 clients from
// the recent sweep normalise every read through Array.isArray / ?? [] / typeof
// guards, so EVERY one of them fails silently in exactly this way.
//
// The assertion is therefore not "does it parse" — a degenerate parse parses.
// It is "did anything survive the parse", checked against what the recorded
// body actually contains.
//
// Fixtures are refreshed with:
//   node scripts/record-api-fixtures.mjs --base http://127.0.0.1:3100 --cookie <jar>
// The diff on those files IS the contract change, and reviewing it is the point.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const FIXTURES = resolve(process.cwd(), "src/__tests__/fixtures/api");

function fixture(path: string): unknown {
  const name = path.replace(/^\/api\/v1\//, "").replace(/[/.]/g, "_");
  return JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), "utf8"));
}

/** Serve every request from the recorded body for `path`. */
function serve(path: string): void {
  const body = fixture(path);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

/** True when a parsed value carries no information at all. */
function isDegenerate(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "object") {
    const vals = Object.values(value as Record<string, unknown>);
    if (vals.length === 0) return true;
    return vals.every((v) => isDegenerate(v));
  }
  return false;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clients parse real recorded responses without silently emptying them", () => {
  it("has fixtures to test against", () => {
    // Vacuity floor: without this, a missing fixture directory would make
    // every case below skip and the file would assert nothing.
    const index = JSON.parse(
      readFileSync(resolve(FIXTURES, "index.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(index).length).toBeGreaterThan(30);
  });

  it("reads the field the server actually sends for reply bands", async () => {
    serve("/api/v1/replies/summary");
    const { getReplySummary } = await import("@/lib/replies-api");
    const out = await getReplySummary();
    const raw = fixture("/api/v1/replies/summary") as Record<string, number>;
    // Every band the server sent must survive the parse with its value.
    expect(out.window_days).toBe(raw.window_days);
    expect(out.total).toBe(raw.total);
    expect(out.unclassified_replies).toBe(raw.unclassified_replies);
  });

  it("keeps the per-provider capability map, including the asymmetric one", async () => {
    serve("/api/v1/audience-destinations/providers");
    const { getDestinationProviders } =
      await import("@/lib/audience-destinations-api");
    const out = await getDestinationProviders();
    const raw = fixture("/api/v1/audience-destinations/providers") as {
      capabilities: Record<string, { diagnostics: boolean }>;
    };
    expect(Object.keys(out.capabilities).sort()).toEqual(
      Object.keys(raw.capabilities).sort(),
    );
    // The whole point of that surface: providers differ. If the parse
    // flattened them, this is where it shows.
    const diagnostics = Object.values(out.capabilities).map(
      (c) => c.diagnostics,
    );
    expect(new Set(diagnostics).size).toBeGreaterThan(1);
  });

  it("keeps every registered metric and its runtime status", async () => {
    serve("/api/v1/reporting/metric-registry");
    const { getMetricRegistry } = await import("@/lib/reporting-registry-api");
    const out = await getMetricRegistry();
    const raw = fixture("/api/v1/reporting/metric-registry") as {
      items: unknown[];
      schema_version: string;
    };
    expect(out.metrics).toHaveLength(raw.items.length);
    expect(out.schema_version).toBe(raw.schema_version);
    expect(out.metrics.every((m) => m.key !== "")).toBe(true);
    // `unknown` would mean the status field was misread.
    expect(out.metrics.some((m) => m.runtime_status === "supported")).toBe(
      true,
    );
  });

  it("keeps the consent ledger's qualifications, not just its rows", async () => {
    serve("/api/v1/consent/events");
    const { getConsentLedger } = await import("@/lib/consent-evidence-api");
    const out = await getConsentLedger();
    const raw = fixture("/api/v1/consent/events") as {
      events: unknown[];
      source_planes: string[];
    };
    expect(out.events).toHaveLength(raw.events.length);
    expect(out.source_planes).toEqual(raw.source_planes);
    if (out.events.length > 0) {
      // Both timestamps must survive — the gap between them is the point.
      expect(out.events[0].created_at).not.toBe("");
      expect(out.events[0].recorded_at).not.toBe("");
      expect(out.events[0].policy_version).not.toBe("");
    }
  });

  it("keeps predictive sufficiency, which decides whether a score is shown", async () => {
    serve("/api/v1/predictive/profiles");
    const { listPredictiveProfiles } = await import("@/lib/predictive-api");
    const out = await listPredictiveProfiles();
    const raw = fixture("/api/v1/predictive/profiles") as { items: unknown[] };
    expect(out).toHaveLength(raw.items.length);
    if (out.length > 0) {
      // Misreading this field would present placeholders as findings.
      expect(out[0].data_sufficiency).not.toBe("");
      expect(out[0].email).not.toBe("");
    }
  });

  it("keeps every service-suite channel and its runtime status", async () => {
    serve("/api/v1/service-suite/catalog");
    const { getServiceSuiteCatalog } = await import("@/lib/service-suite-api");
    const out = await getServiceSuiteCatalog();
    const raw = fixture("/api/v1/service-suite/catalog") as {
      channels: unknown[];
      guardrail: { provider_executed: boolean };
    };
    expect(out.channels).toHaveLength(raw.channels.length);
    expect(out.guardrail.providerExecuted).toBe(false);
    expect(out.guardrail.providerExecuted).toBe(
      raw.guardrail.provider_executed,
    );
    expect(out.channels.every((c) => c.runtimeStatus !== "")).toBe(true);
    expect(
      out.capabilities.find(
        (capability) => capability.key === "outbound_reply_delivery",
      ),
    ).toMatchObject({
      status: "held",
      code: "helpdesk_delivery_unavailable",
    });
  });

  it("keeps report-derived DMARC meta without treating it as DNS inventory", async () => {
    serve("/api/v1/deliverability/dmarc-reports");
    const { dmarcHasNoReports, getDmarcReports } =
      await import("@/lib/workspace-ops-api");
    const out = await getDmarcReports();
    const raw = fixture("/api/v1/deliverability/dmarc-reports") as {
      meta: { totalReports: number; availableDomains: string[] };
    };
    expect(out.totalReports).toBe(raw.meta.totalReports);
    expect(out.availableDomains).toEqual(raw.meta.availableDomains);
    expect(dmarcHasNoReports(out)).toBe(out.totalReports === 0);
    if (out.totalReports === 0) {
      // availableDomains is derived from stored aggregate-report rows. An
      // empty array says nothing about published DMARC records or DNS health.
      expect(out.availableDomains).toEqual([]);
    }
  });

  it("keeps export retention, which is a deletion deadline", async () => {
    serve("/api/v1/exports/retention-policy");
    const { getExportRetention } = await import("@/lib/workspace-ops-api");
    const out = await getExportRetention();
    const raw = fixture("/api/v1/exports/retention-policy") as {
      retention_days: number;
      max_per_tenant: number;
    };
    expect(out.retention_days).toBe(raw.retention_days);
    expect(out.max_per_tenant).toBe(raw.max_per_tenant);
    expect(isDegenerate(out)).toBe(false);
  });

  it("keeps the webhook sample catalogue intact", async () => {
    serve("/api/v1/outbound-webhooks/playground/events");
    const { getWebhookSampleEvents } =
      await import("@/lib/developer-reference-api");
    const out = await getWebhookSampleEvents();
    const raw = fixture("/api/v1/outbound-webhooks/playground/events") as {
      events: unknown[];
    };
    expect(out).toHaveLength(raw.events.length);
    expect(out.every((e) => e.event_type !== "")).toBe(true);
    // A payload parsed to {} would make every event look contentless.
    expect(out.some((e) => Object.keys(e.sample_payload).length > 0)).toBe(
      true,
    );
  });

  it("fails loudly when a client reads a field the server does not send", () => {
    // Guard the guard. This is the ai-compose shape: the server sends
    // `subject_variants`, a client reading `variants` gets undefined, and a
    // `?? []` turns that into a convincing empty list. If isDegenerate ever
    // stopped recognising that, every assertion above would pass on nothing.
    const serverBody = { subject_variants: ["a", "b"] } as Record<
      string,
      unknown
    >;
    const wrongRead = (serverBody.variants as unknown[]) ?? [];
    expect(isDegenerate(wrongRead)).toBe(true);
    const rightRead = serverBody.subject_variants as unknown[];
    expect(isDegenerate(rightRead)).toBe(false);
  });
});
