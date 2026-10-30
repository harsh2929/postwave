import { describe, expect, it } from "vitest";

import {
  sampleDataAction,
  sampleDataSummary,
  slackConnectAvailability,
  slackConnectMessage,
  slackConnectionSummary,
} from "./workspaceSetup";

describe("slackConnectionSummary", () => {
  it("reports a disconnected workspace without inventing fields", () => {
    expect(slackConnectionSummary({ connected: false })).toEqual({
      connected: false,
      workspace: null,
      channel: null,
      connectedAt: null,
    });
  });

  it("prefers the workspace NAME and falls back to the team id", () => {
    expect(
      slackConnectionSummary({
        connected: true,
        slack_team_id: "T0123",
        slack_team_name: "Acme HQ",
      }).workspace,
    ).toBe("Acme HQ");
    expect(
      slackConnectionSummary({ connected: true, slack_team_id: "T0123" })
        .workspace,
    ).toBe("T0123");
  });

  it("renders a channel the way Slack does, once", () => {
    expect(
      slackConnectionSummary({
        connected: true,
        default_channel_name: "alerts",
      }).channel,
    ).toBe("#alerts");
    expect(
      slackConnectionSummary({
        connected: true,
        default_channel_name: "#alerts",
      }).channel,
    ).toBe("#alerts");
  });

  it("reports a missing channel as absent rather than as an empty name", () => {
    // The Go query COALESCEs both channel columns to '', so "" arrives on the
    // wire for a connection with no default channel. Rendering "#" would be a
    // channel that does not exist.
    const summary = slackConnectionSummary({
      connected: true,
      slack_team_name: "Acme HQ",
      default_channel_id: "",
      default_channel_name: "",
    });
    expect(summary.channel).toBeNull();
  });

  it("treats Go's zero time as unknown, not as the year 1", () => {
    // time.Time has no useful `omitempty`, so an unset timestamp serialises as
    // 0001-01-01T00:00:00Z and a naive relative-time render says "2025 years
    // ago".
    expect(
      slackConnectionSummary({
        connected: true,
        slack_team_name: "Acme HQ",
        created_at: "0001-01-01T00:00:00Z",
      }).connectedAt,
    ).toBeNull();
    expect(
      slackConnectionSummary({
        connected: true,
        created_at: "2026-05-04T09:00:00Z",
      }).connectedAt,
    ).toBe("2026-05-04T09:00:00Z");
  });
});

describe("slackConnectAvailability", () => {
  it("never reports a failed probe as an unconfigured deployment", () => {
    // The dangerous confusion: "we couldn't ask" rendered as "your admin never
    // set this up" sends an operator to change env vars for no reason.
    expect(
      slackConnectAvailability({
        connected: false,
        availability: null,
        availabilityFailed: true,
      }),
    ).toBe("unknown");
    expect(slackConnectMessage("unknown")).toMatch(/Couldn't check/i);
  });

  it("says the install is browser-only when the deployment CAN do it", () => {
    expect(
      slackConnectAvailability({
        connected: false,
        availability: { configured: true },
        availabilityFailed: false,
      }),
    ).toBe("browser_only");
    expect(slackConnectMessage("browser_only")).toMatch(/signed-in browser/i);
  });

  it("says no device can connect when the deployment has no Slack app", () => {
    expect(
      slackConnectAvailability({
        connected: false,
        availability: { configured: false },
        availabilityFailed: false,
      }),
    ).toBe("unconfigured");
    expect(slackConnectMessage("unconfigured")).toMatch(/on any device/i);
  });

  it("stops offering to connect what is already connected", () => {
    expect(
      slackConnectAvailability({
        connected: true,
        availability: { configured: false },
        availabilityFailed: false,
      }),
    ).toBe("connected");
  });
});

describe("sampleDataSummary", () => {
  it("reports an unseeded workspace with nothing to list", () => {
    expect(sampleDataSummary({ seeded: false })).toEqual({
      seeded: false,
      total: null,
      breakdown: [],
      seededAt: null,
    });
  });

  it("distinguishes a marker with no counts from a seed that created nothing", () => {
    // A marker written before the counts field existed is UNKNOWN. Rendering
    // it as 0 claims the seeder produced no rows, which is a different and
    // false statement.
    expect(sampleDataSummary({ seeded: true }).total).toBeNull();
    expect(
      sampleDataSummary({
        seeded: true,
        counts: {
          subscribers: 0,
          lists: 0,
          segments: 0,
          campaigns: 0,
          sequences: 0,
        },
      }).total,
    ).toBe(0);
  });

  it("lists only the resources that actually got rows, largest first", () => {
    const summary = sampleDataSummary({
      seeded: true,
      counts: {
        subscribers: 50,
        lists: 0,
        segments: 2,
        campaigns: 3,
        sequences: 1,
      },
    });
    expect(summary.total).toBe(56);
    expect(summary.breakdown.map((entry) => entry.label)).toEqual([
      "Subscribers",
      "Campaigns",
      "Segments",
      "Sequences",
    ]);
  });

  it("ignores counts the server could not have meant", () => {
    const summary = sampleDataSummary({
      seeded: true,
      counts: { subscribers: -4, lists: Number.NaN, campaigns: 2.7 },
    });
    expect(summary.total).toBe(2);
    expect(summary.breakdown).toEqual([{ label: "Campaigns", count: 2 }]);
  });

  it("treats an unparseable seeded_at as unknown", () => {
    expect(sampleDataSummary({ seeded: true, seeded_at: "" }).seededAt).toBeNull();
    expect(
      sampleDataSummary({ seeded: true, seeded_at: "not a date" }).seededAt,
    ).toBeNull();
  });
});

describe("sampleDataAction", () => {
  it("offers exactly one verb, decided by the workspace marker", () => {
    expect(sampleDataAction(sampleDataSummary({ seeded: false }))).toBe("seed");
    expect(sampleDataAction(sampleDataSummary({ seeded: true }))).toBe("remove");
  });
});
