/**
 * Omnichannel definitions — the render contract.
 *
 * THE CLAIM THIS SCREEN COULD GET DANGEROUSLY WRONG is that anything here is
 * sending. Omnichannel execution is disabled by a compile-time constant
 * (`omnichannelRuntimeQualified = false`, omnichannel.go:22) and every response
 * carries a fail-closed `runtimecapability.Descriptor` saying so — but the rows
 * still carry a `status` column that a person typed, and "sending" in a status
 * column looks exactly like "sending" from a dispatcher. This file pins the
 * caveat to the screen so it cannot be quietly removed as visual noise.
 *
 * The pure rules — traffic-split validation, RCS fallback wiring, unknown
 * channels, absence-vs-zero — are in src/lib/omnichannelDefinitions.test.ts;
 * this file proves they surface.
 *
 * WHY THE HOOKS ARE MOCKED PER-HOOK. The `@tanstack/react-query` harness sets
 * ONE result for EVERY `useQuery` in the module graph, so the catalog query and
 * the campaign-list query would receive each other's payload — the mock-shape
 * mismatch that makes a suite pass while asserting nothing. Mocking
 * `@/hooks/useOmnichannel` gives each query its own correctly-shaped answer.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  parseOmniCampaignList,
  parseOmniCatalog,
  type OmniCampaignDefinition,
  type OmniCatalog,
} from "@/lib/omnichannelDefinitions";

const mockListResult: {
  data: OmniCampaignDefinition[] | undefined;
  isError: boolean;
  isLoading: boolean;
  isRefetching: boolean;
  refetch: () => unknown;
} = {
  data: undefined,
  isError: false,
  isLoading: false,
  isRefetching: false,
  refetch: jest.fn(async () => undefined),
};

const mockCatalogResult: { data: OmniCatalog | undefined; isError: boolean } = {
  data: undefined,
  isError: false,
};

jest.mock("@/hooks/useOmnichannel", () => ({
  useOmnichannelCampaigns: () => mockListResult,
  useOmnichannelCatalog: () => mockCatalogResult,
  useOmnichannelCampaign: () => ({ data: undefined, isError: false }),
}));

// eslint-disable-next-line import/first -- must follow the jest.mock hoist.
import Omnichannel from "../app/(tabs)/omnichannel";

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

const CATALOG = parseOmniCatalog({
  schema_version: "klv01.omnichannel.v1",
  runtime: UNAVAILABLE_RUNTIME,
  channels: [
    { key: "email", label: "Email", runtime_status: "unavailable", provider: "postwave" },
    { key: "sms", label: "SMS", runtime_status: "unavailable", provider: "twilio" },
    { key: "rcs", label: "RCS", runtime_status: "unavailable", provider: "google-rbm" },
  ],
  send_strategies: [],
  recipient_snapshot_modes: [],
  path_statuses: ["draft", "ready", "sent"],
})!;

function definitions(items: Record<string, unknown>[]): OmniCampaignDefinition[] {
  return parseOmniCampaignList({ items })!;
}

function load(items: Record<string, unknown>[]) {
  mockListResult.data = definitions(items);
  mockCatalogResult.data = CATALOG;
}

afterEach(() => {
  mockListResult.data = undefined;
  mockListResult.isError = false;
  mockListResult.isLoading = false;
  mockCatalogResult.data = undefined;
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

const TWO_CHANNEL = {
  id: "omni-1",
  name: "Black Friday multi-touch",
  status: "draft",
  objective: "marketing",
  recipient_snapshot_mode: "send_time",
  send_strategy: { mode: "gradual" },
  runtime: UNAVAILABLE_RUNTIME,
  paths: [
    {
      id: "p1",
      path_key: "email",
      name: "Email blast",
      channel: "email",
      status: "draft",
      traffic_weight_basis_points: 7000,
      sequence: 0,
      message_template_id: "tpl-1",
    },
    {
      id: "p2",
      path_key: "sms",
      name: "SMS nudge",
      channel: "sms",
      status: "draft",
      traffic_weight_basis_points: 3000,
      sequence: 1,
    },
  ],
  created_at: "2026-07-01T10:00:00Z",
  updated_at: "2026-07-02T10:00:00Z",
};

describe("the omnichannel list", () => {
  it("renders a bounded first frame while the list is still loading", async () => {
    mockListResult.isLoading = true;
    const view = await render(<Omnichannel />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    expect(screen.getAllByText("Omnichannel").length).toBeGreaterThan(0);
  });

  it("explains what a definition IS rather than saying 'nothing here'", async () => {
    load([]);

    await render(<Omnichannel />, { wrapper });

    expect(screen.getByText("No cross-channel definitions")).toBeTruthy();
    expect(screen.getByText(/up to ten channel paths/)).toBeTruthy();
  });

  it("leads with the channels a definition spans", async () => {
    load([TWO_CHANNEL]);

    await render(<Omnichannel />, { wrapper });

    expect(screen.getByText("Black Friday multi-touch")).toBeTruthy();
    expect(screen.getAllByText("Email").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SMS").length).toBeGreaterThan(0);
  });

  it("says NOTHING IS SENDING, in the server's own words", async () => {
    load([TWO_CHANNEL]);

    await render(<Omnichannel />, { wrapper });

    expect(
      screen.getAllByText("Definitions only — nothing here is sending").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/was not materialized, evaluated, or dispatched/)
        .length,
    ).toBeGreaterThan(0);
  });

  it("withholds the metadata caveat when no status reads as live", async () => {
    load([TWO_CHANNEL]);

    await render(<Omnichannel />, { wrapper });

    expect(
      screen.queryByText(/persisted metadata on the row, not a report/),
    ).toBeNull();
  });

  it("adds the metadata caveat as soon as a status READS as live", async () => {
    load([{ ...TWO_CHANNEL, status: "sending" }]);

    await render(<Omnichannel />, { wrapper });

    expect(
      screen.getAllByText(/persisted metadata on the row, not a report/).length,
    ).toBeGreaterThan(0);
  });

  it("offers a status filter and a search across channels", async () => {
    load([TWO_CHANNEL]);

    await render(<Omnichannel />, { wrapper });

    expect(screen.getByLabelText("Draft")).toBeTruthy();
    expect(screen.getByLabelText("Scheduled")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Search omnichannel definitions by name or channel",
      ),
    ).toBeTruthy();
  });
});

describe("the definition sheet", () => {
  it("opens from the row without a second request and lists every path", async () => {
    load([TWO_CHANNEL]);

    await render(<Omnichannel />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/Black Friday multi-touch\./));

    expect(screen.getByText("Email blast")).toBeTruthy();
    expect(screen.getByText("SMS nudge")).toBeTruthy();
    expect(screen.getByText(/70% of traffic · template bound/)).toBeTruthy();
    expect(screen.getByText(/30% of traffic · no template bound/)).toBeTruthy();
  });

  it("flags a traffic split that would fail the server's own validation", async () => {
    load([
      {
        ...TWO_CHANNEL,
        paths: [
          { ...TWO_CHANNEL.paths[0], traffic_weight_basis_points: 5000 },
          { ...TWO_CHANNEL.paths[1], traffic_weight_basis_points: 3000 },
        ],
      },
    ]);

    await render(<Omnichannel />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/Black Friday multi-touch\./));

    expect(
      screen.getByText(/Traffic weights total 8000 of 10000 basis points/),
    ).toBeTruthy();
  });

  it("flags an RCS path with no SMS fallback", async () => {
    load([
      {
        ...TWO_CHANNEL,
        paths: [
          {
            id: "p9",
            path_key: "rcs",
            name: "RCS rich card",
            channel: "rcs",
            status: "draft",
            traffic_weight_basis_points: 10000,
            sequence: 0,
          },
        ],
      },
    ]);

    await render(<Omnichannel />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/Black Friday multi-touch\./));

    expect(
      screen.getByText(/Fallback wiring is incomplete on: rcs/),
    ).toBeTruthy();
  });

  it("names a channel the schema does not list", async () => {
    load([
      {
        ...TWO_CHANNEL,
        paths: [
          {
            id: "p9",
            path_key: "fax",
            name: "Fax path",
            channel: "fax",
            status: "draft",
            traffic_weight_basis_points: 10000,
            sequence: 0,
          },
        ],
      },
    ]);

    await render(<Omnichannel />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/Black Friday multi-touch\./));

    expect(
      screen.getByText("The channel schema does not list: fax."),
    ).toBeTruthy();
  });

  it("states an ABSENT traffic weight rather than printing 0%", async () => {
    load([
      {
        ...TWO_CHANNEL,
        paths: [
          { ...TWO_CHANNEL.paths[0], traffic_weight_basis_points: 0 },
          { ...TWO_CHANNEL.paths[1], traffic_weight_basis_points: 0 },
        ],
      },
    ]);

    await render(<Omnichannel />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/Black Friday multi-touch\./));

    expect(screen.getAllByText(/no traffic weight/).length).toBe(2);
    expect(screen.queryByText(/0% of traffic/)).toBeNull();
    // An undeclared split is not an unbalanced one — no false alarm.
    expect(screen.queryByText(/Traffic weights total/)).toBeNull();
  });

  it("does not declare a send strategy the definition never set", async () => {
    load([{ ...TWO_CHANNEL, send_strategy: {} }]);

    await render(<Omnichannel />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/Black Friday multi-touch\./));

    expect(screen.getByText("not declared")).toBeTruthy();
  });
});
