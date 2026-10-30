/**
 * The advisory send-window line under the schedule sheet's picker
 * (P2.11, desktop parity: SendChecklist's send-window row).
 *
 * The sentences and their precedence are vitest-pinned in
 * src/lib/sendWindowScheduleLine.test.ts. What only a render can pin:
 *   - the sheet asks POST /api/v1/send-window/check about the MINUTE the
 *     wheel rests on, through the real hook → api → parser chain (the
 *     transport seam that mocked-hook tests leave uncovered);
 *   - each state — checking, verdict, failed, offline, not-applicable — is
 *     the line the operator sees, and NONE of them disables Save: the check
 *     is advisory by contract, the server re-evaluates on schedule.
 *
 * Rendered via a RELATIVE import: jest.routes.config.cjs maps
 * `@/components/campaigns/*` to a null stub, which would make every assertion
 * here vacuous.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";

import type { CampaignDetail } from "../src/hooks/useCampaigns";
import { CampaignScheduleModal } from "../src/components/campaigns/CampaignScheduleModal";

const queryHarness = require("./mocks/reactQuery.cjs");
const gateHarness = require("./mocks/queryHooks.cjs");
const apiRuntime = require("./mocks/apiRuntime.cjs");

// jest.routes.config.cjs maps the `@/api/sdkClient` SPECIFIER to apiRuntime,
// but src/api/request.ts reaches the client through `./sdkClient`, which the
// mapper never sees — so the real factory ran and built the @postwave/sdk
// mock, whose Proxy hands back a fresh jest.fn() on every property read and
// so can never be asserted on. Mocking the resolved module routes both
// importers to the ONE shared `request` fn this file inspects.
jest.mock("../src/api/sdkClient", () => require("./mocks/apiRuntime.cjs"));

const BLOCKED_WIRE = {
  inside_window: false,
  enforcement: "block",
  should: "block",
  reason: "weekday Sunday not in policy bitmap",
};

/** The parsed shape the hook's queryFn yields — what `data` carries. */
const BLOCKED_VERDICT = {
  insideWindow: false,
  enforcement: "block",
  should: "block",
  reason: "weekday Sunday not in policy bitmap",
};

const LOADED = {
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  isPending: false,
  isSuccess: true,
  refetch: jest.fn(async () => ({ data: undefined })),
};

/**
 * A future instant with stray seconds/millis, and the minute the check must
 * ask about — derived by hand, not through the function under test.
 */
function pickedFixture() {
  const picked = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  picked.setUTCSeconds(42, 913);
  const minute = new Date(picked);
  minute.setUTCSeconds(0, 0);
  return { picked, minuteISO: minute.toISOString() };
}

function campaign(over: Partial<CampaignDetail> = {}): CampaignDetail {
  return {
    id: "c1",
    name: "Autumn launch",
    status: "draft",
    scheduled_at: pickedFixture().picked.toISOString(),
    segment_id: null,
    ...over,
  } as unknown as CampaignDetail;
}

function sendWindowQuery() {
  const entries = queryHarness
    .__getQueryOptionsForTests()
    .filter(
      (entry: { kind: string; options: { queryKey?: unknown[] } }) =>
        entry.kind === "query" &&
        entry.options.queryKey?.[0] === "send-window-check",
    );
  return entries[entries.length - 1]?.options;
}

function saveButton(result: Awaited<ReturnType<typeof render>>) {
  return result.getByLabelText("Save");
}

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
});

describe("campaign schedule sheet — send-window verdict line", () => {
  it("asks POST /send-window/check about the minute the wheel rests on, through the real chain", async () => {
    const { picked, minuteISO } = pickedFixture();
    // Path-keyed so the banner's own request during mount still gets a body.
    apiRuntime.request.mockImplementation(
      async (_method: string, path: string) =>
        path === "/api/v1/send-window/check" ? BLOCKED_WIRE : {},
    );
    await render(
      <CampaignScheduleModal
        visible
        onClose={jest.fn()}
        campaign={campaign({ scheduled_at: picked.toISOString() })}
      />,
    );

    const options = sendWindowQuery();
    expect(options).toBeDefined();
    expect(options.enabled).toBe(true);
    expect(options.queryKey[2]).toBe(minuteISO);

    const verdict = await options.queryFn();
    expect(apiRuntime.request).toHaveBeenCalledWith(
      "POST",
      "/api/v1/send-window/check",
      { body: { scheduled_at: minuteISO } },
    );
    expect(verdict).toEqual(BLOCKED_VERDICT);
  });

  it("renders desktop's blocked sentence with the server reason verbatim — and Save stays enabled", async () => {
    queryHarness.__setQueryResultForTests({ ...LOADED, data: BLOCKED_VERDICT });
    const result = await render(
      <CampaignScheduleModal visible onClose={jest.fn()} campaign={campaign()} />,
    );
    expect(
      result.getByText(
        "Outside the send window — sends are blocked (weekday Sunday not in policy bitmap).",
      ),
    ).toBeTruthy();
    expect(saveButton(result).props.accessibilityState.disabled).toBe(false);
  });

  it("says 'checking' while the verdict is in flight", async () => {
    // The harness default is a query still loading.
    const result = await render(
      <CampaignScheduleModal visible onClose={jest.fn()} campaign={campaign()} />,
    );
    expect(result.getByText("Checking the send window…")).toBeTruthy();
    expect(saveButton(result).props.accessibilityState.disabled).toBe(false);
  });

  it("a failed check is named and says scheduling still works", async () => {
    queryHarness.__setQueryResultForTests({
      ...LOADED,
      data: undefined,
      isSuccess: false,
      isError: true,
      error: Object.assign(new Error("upstream"), { status: 500 }),
    });
    const result = await render(
      <CampaignScheduleModal visible onClose={jest.fn()} campaign={campaign()} />,
    );
    const line = result.getByTestId("send-window-line");
    expect(line.props.children).toMatch(/^Couldn't check the send window\./);
    expect(line.props.children).toMatch(/You can still schedule\.$/);
    expect(saveButton(result).props.accessibilityState.disabled).toBe(false);
  });

  it("offline says so instead of spinning, and does not fire the check", async () => {
    gateHarness.__setIsOnlineForTests(false);
    const result = await render(
      <CampaignScheduleModal visible onClose={jest.fn()} campaign={campaign()} />,
    );
    expect(
      result.getByText(
        "Offline — the send window can't be checked. You can still schedule.",
      ),
    ).toBeTruthy();
    expect(sendWindowQuery().enabled).toBe(false);
    expect(saveButton(result).props.accessibilityState.disabled).toBe(false);
  });

  it("best-time mode has no single instant to check: no line, no request", async () => {
    queryHarness.__setQueryResultForTests({ ...LOADED, data: BLOCKED_VERDICT });
    const result = await render(
      <CampaignScheduleModal
        visible
        onClose={jest.fn()}
        campaign={campaign({ per_recipient_optimize: true })}
      />,
    );
    expect(result.queryByTestId("send-window-line")).toBeNull();
    expect(sendWindowQuery().enabled).toBe(false);
  });
});
