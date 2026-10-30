import { describe, expect, it } from "vitest";

import {
  brokenFallbacks,
  channelSpan,
  claimsRuntimeState,
  matchesOmniQuery,
  matchesOmniStatus,
  parseOmniCampaign,
  parseOmniCampaignList,
  parseOmniCatalog,
  parseOmniRuntime,
  pathStatusIsRuntimeClaim,
  runtimeIsExecuting,
  timestampOrNull,
  trafficSplit,
  unknownChannels,
  type OmniCampaignDefinition,
} from "./omnichannelDefinitions";

/** The descriptor `runtimecapability.Unavailable` actually emits. */
const UNAVAILABLE_RUNTIME = {
  capability: "omnichannel_campaign_execution",
  runtime_status: "unavailable",
  execution_enabled: false,
  code: "omnichannel_runtime_unavailable",
  message:
    "Omnichannel campaign execution is unavailable; the campaign was not materialized, evaluated, or dispatched.",
  prerequisites: [
    "explicit_audience_enforcement",
    "durable_dispatcher",
    "live_provider_certification",
  ],
};

function path(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "path-1",
    path_key: "email",
    name: "Email path",
    channel: "email",
    status: "draft",
    traffic_weight_basis_points: 10000,
    sequence: 0,
    ...overrides,
  };
}

function campaignWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "omni-1",
    tenant_id: "t-1",
    name: "Black Friday multi-touch",
    status: "draft",
    objective: "marketing",
    recipient_snapshot_mode: "send_time",
    runtime: UNAVAILABLE_RUNTIME,
    paths: [path()],
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-02T10:00:00Z",
    ...overrides,
  };
}

function campaign(overrides: Record<string, unknown> = {}): OmniCampaignDefinition {
  return parseOmniCampaign(campaignWire(overrides))!;
}

describe("runtime containment", () => {
  it("reads the fail-closed descriptor the server actually sends", () => {
    const runtime = parseOmniRuntime(UNAVAILABLE_RUNTIME)!;
    expect(runtime.executionEnabled).toBe(false);
    expect(runtime.runtimeStatus).toBe("unavailable");
    expect(runtime.prerequisites).toEqual([
      "explicit_audience_enforcement",
      "durable_dispatcher",
      "live_provider_certification",
    ]);
    expect(runtimeIsExecuting(runtime)).toBe(false);
  });

  it("treats a MISSING runtime block as not executing, never as fine", () => {
    expect(runtimeIsExecuting(null)).toBe(false);
    expect(parseOmniRuntime(undefined)).toBeNull();
    expect(parseOmniRuntime({})).toBeNull();
    // execution_enabled absent → false, not undefined-and-truthy-later.
    expect(
      parseOmniRuntime({ capability: "x", runtime_status: "unavailable" })
        ?.executionEnabled,
    ).toBe(false);
  });

  it("only reports execution when the server explicitly enables it", () => {
    const runtime = parseOmniRuntime({
      capability: "omnichannel_campaign_execution",
      runtime_status: "available",
      execution_enabled: true,
    })!;
    expect(runtimeIsExecuting(runtime)).toBe(true);
  });
});

describe("status is persisted metadata, not a dispatcher report", () => {
  it("marks the statuses that would read as a live delivery claim", () => {
    expect(pathStatusIsRuntimeClaim("draft")).toBe(false);
    expect(pathStatusIsRuntimeClaim("ready")).toBe(false);
    expect(pathStatusIsRuntimeClaim("sending")).toBe(true);
    expect(pathStatusIsRuntimeClaim("SENT")).toBe(true);
    expect(pathStatusIsRuntimeClaim("scheduled")).toBe(true);
  });

  it("finds a live-sounding claim on the campaign OR on any path", () => {
    expect(claimsRuntimeState(campaign())).toBe(false);
    expect(claimsRuntimeState(campaign({ status: "sending" }))).toBe(true);
    expect(
      claimsRuntimeState(
        campaign({ paths: [path({ status: "scheduled" })] }),
      ),
    ).toBe(true);
  });
});

describe("parseOmniCampaign", () => {
  it("requires an id — an unidentified row cannot be opened", () => {
    expect(parseOmniCampaign({ name: "x" })).toBeNull();
    expect(parseOmniCampaign(null)).toBeNull();
  });

  it("orders paths by sequence, then deterministically by key", () => {
    const parsed = campaign({
      paths: [
        path({ path_key: "sms", channel: "sms", sequence: 1 }),
        path({ path_key: "whatsapp", channel: "whatsapp", sequence: 0 }),
        path({ path_key: "email", channel: "email", sequence: 0 }),
      ],
    });
    expect(parsed.paths.map((p) => p.pathKey)).toEqual([
      "email",
      "whatsapp",
      "sms",
    ]);
  });

  it("counts the unschema'd maps rather than pretending to read them", () => {
    const parsed = campaign({
      audience_strategy: { mode: "union", segments: ["a", "b"] },
      schedule: {},
      send_strategy: { mode: "gradual", duration_seconds: 3600 },
      paths: [path({ audience: { segment_id: "s1" }, settings: {} })],
    });
    expect(parsed.audienceStrategyKeys).toBe(2);
    expect(parsed.scheduleKeys).toBe(0);
    expect(parsed.sendStrategyMode).toBe("gradual");
    expect(parsed.paths[0]?.audienceKeys).toBe(1);
    expect(parsed.paths[0]?.settingsKeys).toBe(0);
  });

  it("drops Go's zero timestamp instead of printing the year 1", () => {
    expect(timestampOrNull("0001-01-01T00:00:00Z")).toBeNull();
    expect(timestampOrNull("")).toBeNull();
    expect(timestampOrNull("not a date")).toBeNull();
    expect(timestampOrNull("2026-07-01T10:00:00Z")).toBe("2026-07-01T10:00:00Z");
    expect(campaign({ created_at: "0001-01-01T00:00:00Z" }).createdAt).toBeNull();
  });
});

describe("parseOmniCampaignList", () => {
  it("keeps a broken envelope separable from an empty workspace", () => {
    expect(parseOmniCampaignList(null)).toBeNull();
    expect(parseOmniCampaignList({})).toBeNull();
    expect(parseOmniCampaignList([campaignWire()])).toBeNull();
    expect(parseOmniCampaignList({ items: [] })).toEqual([]);
  });

  it("skips unusable rows without losing the usable ones", () => {
    const list = parseOmniCampaignList({
      items: [campaignWire(), { name: "no id" }, campaignWire({ id: "omni-2" })],
    })!;
    expect(list.map((c) => c.id)).toEqual(["omni-1", "omni-2"]);
  });
});

describe("channelSpan", () => {
  it("is the distinct channels in path order — the whole point of the surface", () => {
    const parsed = campaign({
      paths: [
        path({ path_key: "email", channel: "email", sequence: 0 }),
        path({ path_key: "sms", channel: "sms", sequence: 1 }),
        path({ path_key: "email-2", channel: "email", sequence: 2 }),
      ],
    });
    expect(channelSpan(parsed)).toEqual(["email", "sms"]);
  });

  it("names an unrecognised channel rather than dropping it", () => {
    const parsed = campaign({ paths: [path({ channel: "" })] });
    expect(channelSpan(parsed)).toEqual(["unknown"]);
  });
});

describe("trafficSplit", () => {
  it("reports NO split when the definition declares no weights", () => {
    const split = trafficSplit(
      campaign({ paths: [path({ traffic_weight_basis_points: 0 })] }),
    );
    expect(split.declared).toBe(false);
    expect(split.entries[0]?.percent).toBeNull();
  });

  it("converts basis points to percentages", () => {
    const split = trafficSplit(
      campaign({
        paths: [
          path({ path_key: "a", traffic_weight_basis_points: 7500 }),
          path({ path_key: "b", channel: "sms", traffic_weight_basis_points: 2500 }),
        ],
      }),
    );
    expect(split.entries.map((e) => e.percent)).toEqual([75, 25]);
    expect(split.balanced).toBe(true);
  });

  it("flags a multi-path split that does not close, as Validate would", () => {
    const split = trafficSplit(
      campaign({
        paths: [
          path({ path_key: "a", traffic_weight_basis_points: 5000 }),
          path({ path_key: "b", channel: "sms", traffic_weight_basis_points: 3000 }),
        ],
      }),
    );
    expect(split.totalBasisPoints).toBe(8000);
    expect(split.balanced).toBe(false);
  });

  it("exempts a single-path definition, exactly as the server rule does", () => {
    const split = trafficSplit(
      campaign({ paths: [path({ traffic_weight_basis_points: 6000 })] }),
    );
    expect(split.balanced).toBe(true);
  });
});

describe("brokenFallbacks", () => {
  it("flags an RCS path with no fallback at all", () => {
    const parsed = campaign({
      paths: [path({ path_key: "rcs", channel: "rcs", fallback_path_key: "" })],
    });
    expect(brokenFallbacks(parsed)).toEqual(["rcs"]);
  });

  it("flags a fallback that points at nothing", () => {
    const parsed = campaign({
      paths: [path({ path_key: "email", fallback_path_key: "ghost" })],
    });
    expect(brokenFallbacks(parsed)).toEqual(["email"]);
  });

  it("flags an RCS fallback that targets a non-SMS path", () => {
    const parsed = campaign({
      paths: [
        path({ path_key: "rcs", channel: "rcs", fallback_path_key: "email", sequence: 0 }),
        path({ path_key: "email", channel: "email", sequence: 1 }),
      ],
    });
    expect(brokenFallbacks(parsed)).toEqual(["rcs"]);
  });

  it("accepts a correct RCS → SMS fallback", () => {
    const parsed = campaign({
      paths: [
        path({ path_key: "rcs", channel: "rcs", fallback_path_key: "sms", sequence: 0 }),
        path({ path_key: "sms", channel: "sms", sequence: 1 }),
      ],
    });
    expect(brokenFallbacks(parsed)).toEqual([]);
  });
});

describe("parseOmniCatalog", () => {
  const wire = {
    schema_version: "klv01.omnichannel.v1",
    runtime: UNAVAILABLE_RUNTIME,
    channels: [
      { key: "email", label: "Email", runtime_status: "unavailable", provider: "postwave" },
      {
        key: "rcs",
        label: "RCS",
        runtime_status: "unavailable",
        provider: "google-rbm",
        fields: [
          { key: "fallback_path_key", type: "string", required: true },
          { key: "optional_thing", type: "string" },
        ],
      },
    ],
    send_strategies: [{ key: "fixed", label: "Fixed time", runtime_status: "unavailable" }],
    recipient_snapshot_modes: [
      { key: "send_time", label: "Determine recipients at send time", runtime_status: "unavailable" },
    ],
    path_statuses: ["draft", "ready", "sent"],
  };

  it("returns null when the catalog has no channel list", () => {
    expect(parseOmniCatalog({ schema_version: "x" })).toBeNull();
  });

  it("keeps only the REQUIRED fields — the rest are not obligations", () => {
    const catalog = parseOmniCatalog(wire)!;
    expect(catalog.channels.map((c) => c.key)).toEqual(["email", "rcs"]);
    expect(catalog.channels[1]?.requiredFields).toEqual(["fallback_path_key"]);
    expect(catalog.channels[0]?.requiredFields).toEqual([]);
    expect(catalog.sendStrategies).toHaveLength(1);
    expect(catalog.pathStatuses).toContain("draft");
  });

  it("carries the fail-closed runtime through to the catalog", () => {
    expect(runtimeIsExecuting(parseOmniCatalog(wire)!.runtime)).toBe(false);
  });

  it("names a definition's channel that the catalog does not know", () => {
    const catalog = parseOmniCatalog(wire)!;
    const parsed = campaign({
      paths: [path({ path_key: "fax", channel: "fax" })],
    });
    expect(unknownChannels(parsed, catalog)).toEqual(["fax"]);
    // With no catalog loaded we claim nothing — an unavailable schema is not
    // evidence that a channel is unsupported.
    expect(unknownChannels(parsed, null)).toEqual([]);
  });
});

describe("filters", () => {
  it("matches status exactly, with `all` as the escape", () => {
    const parsed = campaign({ status: "scheduled" });
    expect(matchesOmniStatus(parsed, "all")).toBe(true);
    expect(matchesOmniStatus(parsed, "scheduled")).toBe(true);
    expect(matchesOmniStatus(parsed, "draft")).toBe(false);
  });

  it("searches the name AND the paths, because the channel is the question", () => {
    const parsed = campaign({
      name: "Winter promo",
      paths: [path({ path_key: "wa", channel: "whatsapp", name: "WhatsApp blast" })],
    });
    expect(matchesOmniQuery(parsed, "")).toBe(true);
    expect(matchesOmniQuery(parsed, "winter")).toBe(true);
    expect(matchesOmniQuery(parsed, "whatsapp")).toBe(true);
    expect(matchesOmniQuery(parsed, "telegram")).toBe(false);
  });
});
