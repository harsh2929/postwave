/**
 * The in-flight send strip and the bounce mix, rendered (DASHBOARD#45 / #35).
 *
 * Both are SELF-GATING panels, and a self-gating panel has two ways to be
 * wrong that a pure-module test cannot see: it can fail to disappear, and it
 * can crash the screen it is pinned to. Both are rendered here in isolation,
 * against the query mocks the rest of the route suite uses.
 *
 * Assertions go through the composed accessibility label, because that is the
 * whole point of both components — one spoken sentence per panel rather than
 * five orphan numbers.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";

import * as CampaignHooks from "@/hooks/useCampaigns";

// The strip's report read goes through the campaigns hook module, which the
// route config maps to the shared query-hook proxy; the send-preview read is
// a direct useQuery, so it follows the react-query override below.
jest.mock("@/hooks/useCampaignSendChecks", () => ({
  useCampaignSendPreview: () => ({ data: null, isError: false }),
}));

// eslint-disable-next-line import/first
import { ActiveSendStrip } from "@/components/dashboard/ActiveSendStrip";
// eslint-disable-next-line import/first
import { BounceMixCard } from "@/components/dashboard/BounceMixCard";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const hookHarness = CampaignHooks as unknown as {
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetHookResultsForTests();
});

const SENDING = [
  { id: "c1", subject: "Spring launch", status: "sending", open_rate: 0.2 },
];

describe("ActiveSendStrip", () => {
  it("renders nothing when no campaign is in flight", async () => {
    const view = await render(
      <ActiveSendStrip
        campaigns={[{ id: "c0", subject: "Done", status: "sent" }]}
      />,
    );
    expect(view.toJSON()).toBeNull();
  });

  it("renders nothing before the campaigns list has loaded", async () => {
    const view = await render(<ActiveSendStrip campaigns={undefined} />);
    expect(view.toJSON()).toBeNull();
  });

  it("pins the live send with its progress and both rates in one spoken line", async () => {
    hookHarness.__setHookResultForTests("useCampaignReport", {
      data: { sent: 10, delivered: 9 },
      isError: false,
    });
    await render(<ActiveSendStrip campaigns={SENDING} />);
    // No audience total from the mocked preview, so the honest numerator-only
    // phrasing — never a percentage invented from a missing denominator.
    expect(
      screen.getByLabelText(
        "Spring launch is sending now. 10 messages sent so far. " +
          "20.0% opened, click rate not reported. Open this campaign.",
      ),
    ).toBeTruthy();
  });

  it("says the progress read FAILED rather than showing a stalled send", async () => {
    hookHarness.__setHookResultForTests("useCampaignReport", {
      data: undefined,
      isError: true,
    });
    await render(<ActiveSendStrip campaigns={SENDING} />);
    expect(
      screen.getByLabelText(
        "Spring launch is sending now. Live progress couldn't be read just now. " +
          "20.0% opened, click rate not reported. Open this campaign.",
      ),
    ).toBeTruthy();
  });
});

describe("BounceMixCard", () => {
  it("renders nothing on a workspace with no bounces in the window", async () => {
    queryHarness.__setQueryResultForTests({
      data: { windowDays: 30, totalBounces: 0, classes: [] },
      isError: false,
    });
    expect((await render(<BounceMixCard />)).toJSON()).toBeNull();
  });

  it("renders nothing — rather than throwing — on a payload of the wrong shape", async () => {
    // The dashboard route suite drives every query from one override, so this
    // is the state the real screen reaches when any other payload wins.
    queryHarness.__setQueryResultForTests({
      data: { subscribers: 12 },
      isError: false,
    });
    expect((await render(<BounceMixCard />)).toJSON()).toBeNull();
  });

  it("breaks the bounces into classes with one spoken sentence", async () => {
    queryHarness.__setQueryResultForTests({
      data: {
        windowDays: 30,
        totalBounces: 100,
        classes: [
          { code: "hard", label: "Hard bounce", count: 60, share: 0.6 },
          { code: "soft", label: "Soft bounce", count: 40, share: 0.4 },
        ],
      },
      isError: false,
    });
    await render(<BounceMixCard />);
    expect(
      screen.getByLabelText(
        "Why they bounced · last 30 days. 100 bounces. " +
          "Hard bounce, 60, 60.0% of bounces. Soft bounce, 40, 40.0% of bounces. " +
          "Open the deliverability hub.",
      ),
    ).toBeTruthy();
  });

  it("states that the read failed instead of vanishing", async () => {
    queryHarness.__setQueryResultForTests({ data: undefined, isError: true });
    await render(<BounceMixCard />);
    expect(
      screen.getByLabelText("The bounce breakdown couldn't be read just now."),
    ).toBeTruthy();
  });
});
