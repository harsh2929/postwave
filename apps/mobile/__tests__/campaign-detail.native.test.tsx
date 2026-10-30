/**
 * Campaign DETAIL render contract.
 *
 * Coverage for this cluster stopped at pure helpers: nextCampaignPage,
 * campaignGates, campaignAccess — every one of them tested in isolation, and
 * none of them tested as the thing the screen actually renders. The three most
 * consequential paths in the app (send, schedule, delete) had zero behavioural
 * coverage, and the class of bug that produces is precisely the one this
 * cluster shipped: a malformed deep link left `isLoading` false, `isError`
 * false and `c` undefined, every content block sat behind `{c ? … }`, and the
 * screen rendered NOTHING, permanently, with no way back.
 *
 * Two things are pinned here.
 *
 *  1. THE STATE LADDER, in order. A missing id, a deleted campaign, a real
 *     fetch failure and a closed session are four different situations with
 *     four different exits, and each must never render as another. An error
 *     must not read as "nothing here"; a cached session must not read as
 *     "this campaign was deleted".
 *
 *  2. THE GATING MATRIX, as rendered. `campaignGates` is unit-tested, but what
 *     the operator can PRESS is the product of three modules — the route, the
 *     content layout, and the action row — plus the role/connectivity decision
 *     from campaignAccess. A unit test of any one of them cannot catch a
 *     Delete button surviving into a sent campaign, or a viewer being handed a
 *     live "Send now".
 *
 * The action-row chain resolves for real in this environment (see the
 * moduleNameMapper exemption in jest.routes.config.cjs); the leaf report /
 * insight / preview cards stay stubbed.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useCampaigns";

import CampaignDetail from "../app/(tabs)/campaigns/[id]";

const ROUTE_ID = "22222222-2222-4222-8222-222222222222";

/** Mutable so a single test can claim the link carried no id at all. */
let mockRouteParams: Record<string, string> = { id: ROUTE_ID };

jest.mock("expo-router", () => {
  const actual = jest.requireActual<Record<string, unknown>>("expo-router");
  return { ...actual, useLocalSearchParams: () => mockRouteParams };
});

const hooks = QueryHooks as unknown as {
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  mockRouteParams = { id: ROUTE_ID };
  hooks.__resetHookResultsForTests();
  hooks.__resetOnlineGateForTests();
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

function loaded(campaign: Record<string, unknown>) {
  return {
    data: campaign,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: jest.fn(async () => ({ data: campaign })),
  };
}

function failed(error: { status: number; message: string }) {
  return {
    data: undefined,
    error,
    isError: true,
    isFetching: false,
    isLoading: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

const DRAFT = {
  id: ROUTE_ID,
  name: "Spring launch",
  subject: "Spring is here",
  status: "draft",
  body_html: "<p>Hello there</p>",
};

const SENT = {
  id: ROUTE_ID,
  name: "Winter recap",
  subject: "What happened",
  status: "sent",
  body_html: "<p>Hello there</p>",
};

/** accessibilityState.disabled for a button, by its accessible label. */
function disabledFor(label: string): boolean | undefined {
  const node = screen.getByLabelText(label);
  return (node.props as { accessibilityState?: { disabled?: boolean } })
    .accessibilityState?.disabled;
}

describe("campaign detail state ladder", () => {
  it("gives a deep link with no campaign id a way out instead of a blank screen", async () => {
    mockRouteParams = {};

    await render(<CampaignDetail />, { wrapper });

    expect(screen.getByText("Campaign not found")).toBeTruthy();
    expect(
      screen.getByText(/didn't include a campaign/),
    ).toBeTruthy();
    // The exit is the point: without it the screen is a dead end. (The
    // EmptyState CTA takes its accessible name from its Text child rather than
    // an explicit accessibilityLabel, so this asserts on the rendered label.)
    expect(screen.getByText("Back to campaigns")).toBeTruthy();
  });

  it("reads a deleted campaign as gone, not as a failure to load", async () => {
    hooks.__setHookResultForTests(
      "useCampaign",
      failed({ status: 404, message: "not found" }),
    );

    await render(<CampaignDetail />, { wrapper });

    expect(screen.getByText("Campaign not found")).toBeTruthy();
    expect(screen.getByText(/no longer exists/)).toBeTruthy();
    expect(screen.queryByText("Couldn't load this campaign.")).toBeNull();
  });

  it("renders a real fetch failure as a retryable error, never as an empty campaign", async () => {
    hooks.__setHookResultForTests(
      "useCampaign",
      failed({ status: 500, message: "upstream exploded" }),
    );

    await render(<CampaignDetail />, { wrapper });

    expect(screen.getByText("Couldn't load this campaign.")).toBeTruthy();
    // A 500 is not a deletion; conflating them tells the operator their work
    // is gone when it is not.
    expect(screen.queryByText("Campaign not found")).toBeNull();
  });

  it("tells a gate-closed session to reconnect rather than claiming the campaign is missing", async () => {
    hooks.__setOnlineGateForTests({ enabled: false });

    await render(<CampaignDetail />, { wrapper });

    expect(screen.getByText("Reconnect to load campaigns")).toBeTruthy();
    expect(screen.queryByText("Campaign not found")).toBeNull();
    expect(screen.queryByText("Couldn't load this campaign.")).toBeNull();
  });
});

describe("campaign detail gating matrix", () => {
  it("offers a draft its full lifecycle and withholds resend", async () => {
    hooks.__setHookResultForTests("useCampaign", loaded(DRAFT));

    await render(<CampaignDetail />, { wrapper });

    expect(screen.getByLabelText("Edit")).toBeTruthy();
    expect(screen.getByLabelText("Schedule")).toBeTruthy();
    expect(screen.getByLabelText("Send test")).toBeTruthy();
    expect(screen.getByLabelText("Send now")).toBeTruthy();
    expect(screen.getByLabelText("Delete")).toBeTruthy();
    // Resend-to-non-openers needs opens to diff against; a draft has none.
    expect(screen.queryByLabelText("Resend to non-openers")).toBeNull();
  });

  it("offers a sent campaign resend and withholds every irreversible draft action", async () => {
    hooks.__setHookResultForTests("useCampaign", loaded(SENT));

    await render(<CampaignDetail />, { wrapper });

    expect(screen.getByLabelText("Resend to non-openers")).toBeTruthy();
    // Anything past draft must be cancelled, not deleted — and it can no
    // longer be edited, scheduled or sent.
    expect(screen.queryByLabelText("Delete")).toBeNull();
    expect(screen.queryByLabelText("Send now")).toBeNull();
    expect(screen.queryByLabelText("Schedule")).toBeNull();
    expect(screen.queryByLabelText("Edit")).toBeNull();
  });

  it("hides A/B results on a campaign that has no variants", async () => {
    hooks.__setHookResultForTests("useCampaign", loaded(SENT));

    await render(<CampaignDetail />, { wrapper });

    // Shown on every campaign once, where it led straight to "No variants
    // yet" — which taught operators the button was broken.
    expect(screen.queryByLabelText("A/B results")).toBeNull();
  });

  it("offers A/B results on a genuine A/B parent", async () => {
    hooks.__setHookResultForTests(
      "useCampaign",
      loaded({ ...SENT, is_ab_test: true }),
    );

    await render(<CampaignDetail />, { wrapper });

    expect(screen.getByLabelText("A/B results")).toBeTruthy();
  });

  it("withholds send on a draft with no body at all", async () => {
    hooks.__setHookResultForTests(
      "useCampaign",
      loaded({ id: ROUTE_ID, name: "Empty", status: "draft" }),
    );

    await render(<CampaignDetail />, { wrapper });

    expect(screen.queryByLabelText("Send now")).toBeNull();
    expect(screen.queryByLabelText("Send test")).toBeNull();
    // Editing is how you GIVE it a body, so it must stay reachable.
    expect(screen.getByLabelText("Edit")).toBeTruthy();
  });
});

describe("campaign detail denial is explained, not discovered", () => {
  it("disables every mutating action for a read-only viewer and says why", async () => {
    hooks.__setHookResultForTests("useCampaign", loaded(DRAFT));
    hooks.__setOnlineGateForTests({ effectiveRole: "viewer" });

    await render(<CampaignDetail />, { wrapper });

    expect(screen.getByText("Read-only access")).toBeTruthy();
    for (const label of ["Edit", "Schedule", "Send test", "Send now", "Delete"]) {
      expect(disabledFor(label)).toBe(true);
    }
  });

  it("disables mutating actions offline while leaving the campaign readable", async () => {
    hooks.__setHookResultForTests("useCampaign", loaded(DRAFT));
    hooks.__setHookResultForTests("useIsOnline", false);

    await render(<CampaignDetail />, { wrapper });

    expect(screen.getByText("You're offline")).toBeTruthy();
    for (const label of ["Edit", "Schedule", "Send now", "Delete"]) {
      expect(disabledFor(label)).toBe(true);
    }
    // Reading is not gated on connectivity: the header still names the
    // campaign from the offline snapshot.
    expect(screen.getByText("Spring launch")).toBeTruthy();
  });

  it("keeps a draft's actions live for an ordinary editor", async () => {
    hooks.__setHookResultForTests("useCampaign", loaded(DRAFT));

    await render(<CampaignDetail />, { wrapper });

    for (const label of ["Edit", "Schedule", "Send now", "Delete"]) {
      expect(disabledFor(label)).toBe(false);
    }
  });

  it("withholds admin-only duplication from an editor and grants it to an admin", async () => {
    hooks.__setHookResultForTests("useCampaign", loaded(DRAFT));
    // The editor half has to SAY editor: the shared gate mock defaults to an
    // owner (queryHooks.cjs OPEN_GATE), which is an admin role, so an unset
    // role renders Duplicate and the withholding assertion tests nothing.
    hooks.__setOnlineGateForTests({ effectiveRole: "editor" });
    const editor = await render(<CampaignDetail />, { wrapper });
    expect(screen.queryByLabelText("Duplicate")).toBeNull();
    editor.unmount();

    hooks.__setOnlineGateForTests({ effectiveRole: "admin" });
    await render(<CampaignDetail />, { wrapper });
    expect(screen.getByLabelText("Duplicate")).toBeTruthy();
  });
});

describe("campaign detail is not a dead end", () => {
  /**
   * LOVE#50. This screen shows the operator the body and lets them change no
   * word of it — app/(tabs)/campaigns/index.tsx says in its own header comment that
   * full composition stays on the web. Until the handoff row landed, the only
   * way across was to retype a URL from memory.
   *
   * Asserted HERE rather than on the sequence screen because
   * CampaignDetailContent resolves for real in this harness (see the
   * moduleNameMapper exemption in jest.routes.config.cjs) while StepCanvas —
   * which owns the sequence screen's footer — is stubbed to null.
   */
  it("offers the web handoff, with copy as the primary action", async () => {
    hooks.__setHookResultForTests("useCampaign", loaded(DRAFT));

    await render(<CampaignDetail />, { wrapper });

    // Copy leads over Open: the in-app browser does not carry this app's
    // session (mobile authenticates with headers out of SecureStore, not with
    // the dashboard's cookies), so Open can legitimately land on the web
    // sign-in while pasting the link where the user is already signed in
    // always works.
    // Labelled by NAME ("Spring launch"), not subject ("Spring is here"):
    // one campaign gets one name everywhere, matching desktop's
    // CampaignListView and this app's own detail modals. See
    // lib/campaignLabelConsistency.test.
    expect(
      await screen.findByLabelText("Copy the dashboard link for Spring launch"),
    ).toBeTruthy();
    expect(
      await screen.findByLabelText(
        "Open Spring launch in the Moosewave dashboard",
      ),
    ).toBeTruthy();
    // It says the link may ask for a sign-in rather than letting the user find
    // that out after a tap.
    expect(await screen.findByText(/You may need to sign in there/)).toBeTruthy();
  });

  // Deliberately no role variant: WebHandoffRow takes no role input at all, so
  // a viewer-specific case would assert nothing the type system does not
  // already guarantee. The row is offered to everyone who can read the screen,
  // which is the point — the read-only viewer is the person most stuck on it.
});
