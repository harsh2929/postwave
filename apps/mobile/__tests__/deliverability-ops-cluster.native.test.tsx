import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";

/**
 * The 2026-08 desktop-parity ops cluster, card by card. Every card here owns
 * a read the phone never had; the assertions pin the four behaviours that
 * rot silently when nobody renders them in a test:
 *
 *  - a FAILED read is a failure sentence, never an implied all-clear;
 *  - write verbs exist only for the role the manifest floor names, and the
 *    destructive ones go through the confirm with their real blast radius;
 *  - press-armed reads (auth checks, bot opens, control panel) fire NOTHING
 *    until the operator asks;
 *  - server refusals keep their meaning (503 "not configured" ≠ failure,
 *    skipped pillar "not scored" ≠ zero, null balance ≠ zero credits).
 */
const mockWebhookQuery: { data: unknown; isError: boolean; isPending: boolean } =
  { data: undefined, isError: false, isPending: true };
const mockAutoSuppressQuery: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockSetAutoSuppress = { mutate: jest.fn(), isPending: false };
const mockTrapStats: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockTrapHits: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockSoftStats: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockRunSoft = { mutate: jest.fn(), isPending: false };
const mockAuthArmed: boolean[] = [];
const mockAuthQuery: { data: unknown; isError: boolean; error: unknown } = {
  data: undefined,
  isError: false,
  error: null,
};
const mockPlacement: {
  data: unknown;
  isError: boolean;
  isPending: boolean;
  error: unknown;
} = { data: undefined, isError: false, isPending: true, error: null };
const mockDiagnose = {
  mutate: jest.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
  data: undefined as unknown,
};
const mockFeedback = {
  mutate: jest.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
  data: undefined as unknown,
};
const mockEq = {
  mutate: jest.fn(),
  isPending: false,
  isError: false,
  error: null as unknown,
  data: undefined as unknown,
};
const mockCampaigns: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockBotArmed: boolean[] = [];
const mockBotStats: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockBotSignatures: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockCreateSig = { mutate: jest.fn(), isPending: false };
const mockDeleteSig = { mutate: jest.fn(), isPending: false };
const mockProviders: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockCreateProv = { mutate: jest.fn(), isPending: false };
const mockSetProv = { mutate: jest.fn(), isPending: false };
const mockDeleteProv = { mutate: jest.fn(), isPending: false };
const mockCredits: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockPolicyEnabled: boolean[] = [];
const mockPolicyQuery: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockSetMode = { mutate: jest.fn(), isPending: false };
const mockCtlArmed: boolean[] = [];
const mockCtlDomains: { data: unknown; isError: boolean; isPending: boolean } =
  { data: undefined, isError: false, isPending: true };
const mockCtlClick: { data: unknown; isError: boolean; isPending: boolean } = {
  data: undefined,
  isError: false,
  isPending: true,
};
const mockCtlRouting: { data: unknown; isError: boolean; isPending: boolean } =
  { data: undefined, isError: false, isPending: true };
const mockCtlEnt: { data: unknown; isError: boolean; isPending: boolean } = {
  data: undefined,
  isError: false,
  isPending: true,
};
const mockCreateWarmup = { mutate: jest.fn(), isPending: false };
const mockDeleteWarmup = { mutate: jest.fn(), isPending: false };
const mockConfirm = jest.fn<(options: unknown) => Promise<boolean>>(
  async () => true,
);

jest.mock("@/hooks/useDeliverabilityHubOps", () => ({
  useWebhookErrors: () => mockWebhookQuery,
  useClearRepairOverride: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/hooks/useDeliverabilityRecovery", () => ({
  useAutoSuppress: () => mockAutoSuppressQuery,
  useSetAutoSuppress: () => mockSetAutoSuppress,
  useSpamTrapStats: () => mockTrapStats,
  useSpamTrapHits: () => mockTrapHits,
  useSoftBounceStats: () => mockSoftStats,
  useRunSoftBounceRecovery: () => mockRunSoft,
  useRetryEvents: () => ({ data: undefined, isError: false }),
  useSetRetryEventStatus: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/hooks/useDeliverabilityEvidence", () => ({
  useAuthChecks: (armed: boolean) => {
    mockAuthArmed.push(armed);
    return mockAuthQuery;
  },
  usePlacementReport: () => mockPlacement,
  useDiagnoseCampaign: () => mockDiagnose,
  useFeedbackHistoryLookup: () => mockFeedback,
  useEqScoreLookup: () => mockEq,
}));
jest.mock("@/hooks/useDeliverabilityBotOpens", () => ({
  useBotOpenStats: (armed: boolean) => {
    mockBotArmed.push(armed);
    return mockBotStats;
  },
  useBotOpenSignatures: () => mockBotSignatures,
  useCreateBotOpenSignature: () => mockCreateSig,
  useDeleteBotOpenSignature: () => mockDeleteSig,
}));
jest.mock("@/hooks/useDeliverabilityProviders", () => ({
  useProviderConnections: () => mockProviders,
  useCreateProviderConnection: () => mockCreateProv,
  useSetProviderConnection: () => mockSetProv,
  useDeleteProviderConnection: () => mockDeleteProv,
}));
jest.mock("@/hooks/useDeliverabilityVerificationPolicy", () => ({
  useVerificationCredits: () => mockCredits,
  useVerificationPolicy: (enabled: boolean) => {
    mockPolicyEnabled.push(enabled);
    return mockPolicyQuery;
  },
  useSetVerificationMode: () => mockSetMode,
}));
jest.mock("@/hooks/useDeliverabilityControl", () => ({
  useControlDomainSetups: (armed: boolean) => {
    mockCtlArmed.push(armed);
    return mockCtlDomains;
  },
  useClickTrackingPolicy: () => mockCtlClick,
  useRoutingPolicy: () => mockCtlRouting,
  useSendingEntitlement: () => mockCtlEnt,
}));
jest.mock("@/hooks/useDeliverabilityWarmupOps", () => ({
  useCreateWarmupPlan: () => mockCreateWarmup,
  useDeleteWarmupPlan: () => mockDeleteWarmup,
}));
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => mockConfirm,
}));

// eslint-disable-next-line import/first
import { EvidenceError } from "@/api/deliverabilityEvidence";
// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import { AuthChecksCard } from "@/components/deliverability/AuthChecksCard";
// eslint-disable-next-line import/first
import { AutoSuppressCard } from "@/components/deliverability/AutoSuppressCard";
// eslint-disable-next-line import/first
import { BotOpensCard } from "@/components/deliverability/BotOpensCard";
// eslint-disable-next-line import/first
import { CampaignPlacementCard } from "@/components/deliverability/CampaignPlacementCard";
// eslint-disable-next-line import/first
import { ControlPanelCard } from "@/components/deliverability/ControlPanelCard";
// eslint-disable-next-line import/first
import { EqScoreCard } from "@/components/deliverability/EqScoreCard";
// eslint-disable-next-line import/first
import { FeedbackTrailCard } from "@/components/deliverability/FeedbackTrailCard";
// eslint-disable-next-line import/first
import { HygienePlaybooksCard } from "@/components/deliverability/HygienePlaybooksCard";
// eslint-disable-next-line import/first
import { ProvidersCard } from "@/components/deliverability/ProvidersCard";
// eslint-disable-next-line import/first
import { SoftBounceRecoveryCard } from "@/components/deliverability/SoftBounceRecoveryCard";
// eslint-disable-next-line import/first
import { SpamTrapGuardCard } from "@/components/deliverability/SpamTrapGuardCard";
// eslint-disable-next-line import/first
import { VerificationPolicyCard } from "@/components/deliverability/VerificationPolicyCard";
// eslint-disable-next-line import/first
import { WarmupOpsControls } from "@/components/deliverability/WarmupOpsControls";
// eslint-disable-next-line import/first
import { WebhookErrorsCard } from "@/components/deliverability/WebhookErrorsCard";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
  __setHookResultForTests: (name: string, value: unknown) => void;
};

// useCampaigns resolves to the SHARED queryHooks.cjs proxy (the same module
// that serves useOnlineQueryGate), so a jest.mock on it would clobber the
// gate harness for the whole file. Route the campaigns list through the
// proxy's own per-hook lever instead; `mockCampaigns` stays mutable per test.
gateHarness.__setHookResultForTests("useCampaignsList", mockCampaigns);

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  for (const fn of [
    mockSetAutoSuppress.mutate,
    mockRunSoft.mutate,
    mockDiagnose.mutate,
    mockFeedback.mutate,
    mockEq.mutate,
    mockCreateSig.mutate,
    mockDeleteSig.mutate,
    mockCreateProv.mutate,
    mockSetProv.mutate,
    mockDeleteProv.mutate,
    mockSetMode.mutate,
    mockCreateWarmup.mutate,
    mockDeleteWarmup.mutate,
  ]) {
    (fn as jest.Mock).mockReset();
  }
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  Object.assign(mockWebhookQuery, { data: undefined, isError: false, isPending: true });
  Object.assign(mockAutoSuppressQuery, { data: undefined, isError: false });
  Object.assign(mockTrapStats, { data: undefined, isError: false });
  Object.assign(mockTrapHits, { data: undefined, isError: false });
  Object.assign(mockSoftStats, { data: undefined, isError: false });
  Object.assign(mockAuthQuery, { data: undefined, isError: false, error: null });
  Object.assign(mockPlacement, { data: undefined, isError: false, isPending: true, error: null });
  Object.assign(mockDiagnose, { isPending: false, isError: false, error: null, data: undefined });
  Object.assign(mockFeedback, { isPending: false, isError: false, error: null, data: undefined });
  Object.assign(mockEq, { isPending: false, isError: false, error: null, data: undefined });
  Object.assign(mockCampaigns, { data: undefined, isError: false });
  Object.assign(mockBotStats, { data: undefined, isError: false });
  Object.assign(mockBotSignatures, { data: undefined, isError: false });
  Object.assign(mockProviders, { data: undefined, isError: false });
  Object.assign(mockCredits, { data: undefined, isError: false });
  Object.assign(mockPolicyQuery, { data: undefined, isError: false });
  Object.assign(mockCtlDomains, { data: undefined, isError: false, isPending: true });
  Object.assign(mockCtlClick, { data: undefined, isError: false, isPending: true });
  Object.assign(mockCtlRouting, { data: undefined, isError: false, isPending: true });
  Object.assign(mockCtlEnt, { data: undefined, isError: false, isPending: true });
  mockAuthArmed.length = 0;
  mockBotArmed.length = 0;
  mockPolicyEnabled.length = 0;
  mockCtlArmed.length = 0;
});

const ISO = "2026-08-28T12:00:00Z";

describe("WebhookErrorsCard", () => {
  it("reports a failed read as possibly-broken ingestion, never an all-clear", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockWebhookQuery.isError = true;
    const screen = await render(<WebhookErrorsCard />);
    expect(
      screen.getByText(/ingestion may be broken without showing here/),
    ).toBeTruthy();
    expect(screen.queryByText(/delivered and DNS verifications passed/)).toBeNull();
  });

  it("renders failing deliveries and broken DNS identities", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockWebhookQuery.isPending = false;
    mockWebhookQuery.data = {
      items: [
        {
          id: "w1",
          event: "bounce",
          url: "https://hooks.acme.com/e",
          status: "failed",
          statusCode: 500,
          attemptCount: 3,
          lastAttemptAt: ISO,
          error: "timeout",
        },
      ],
      failedVerifications: [
        {
          identityId: "i1",
          domain: "mail.acme.com",
          verifyState: "failed",
          lastError: "NXDOMAIN",
        },
      ],
    };
    const screen = await render(<WebhookErrorsCard />);
    expect(screen.getByText("failing")).toBeTruthy();
    expect(
      screen.getByText(/1 failed webhook delivery · 1 unverified identity in the last 7 days/),
    ).toBeTruthy();
    expect(screen.getByText(/bounce → https:\/\/hooks\.acme\.com\/e/)).toBeTruthy();
    expect(screen.getByText(/mail\.acme\.com · failed · NXDOMAIN/)).toBeTruthy();
  });
});

describe("AutoSuppressCard", () => {
  const STATE = { autoSuppress: false, activeSuppressions: 0, eligibleNow: 2 };

  it("shows a viewer the policy with no flip verb", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockAutoSuppressQuery.data = STATE;
    const screen = await render(<AutoSuppressCard />);
    expect(screen.getByText(/2 identities currently eligible/)).toBeTruthy();
    expect(screen.queryByText("Turn on auto-suppress")).toBeNull();
  });

  it("admin flip names the immediate blast radius in the confirm", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockAutoSuppressQuery.data = STATE;
    const screen = await render(<AutoSuppressCard />);
    fireEvent.press(screen.getByText("Turn on auto-suppress"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockConfirm.mock.calls[0]?.[0]).toMatchObject({
      consequence:
        "2 currently listed identities would be suppressed immediately.",
    });
    await waitFor(() =>
      expect(mockSetAutoSuppress.mutate).toHaveBeenCalledWith(
        true,
        expect.anything(),
      ),
    );
  });

  it("says a failed policy read leaves the real state unknown", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockAutoSuppressQuery.isError = true;
    const screen = await render(<AutoSuppressCard />);
    expect(screen.getByText(/its real state is unknown/)).toBeTruthy();
    expect(screen.queryByText("Turn on auto-suppress")).toBeNull();
  });
});

describe("SpamTrapGuardCard", () => {
  it("renders standing hit evidence beside the counts", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockTrapStats.data = { hitsLast30Days: 3, blocklistedCount: 2, eligibleNow: 1 };
    mockTrapHits.data = [
      { email: "trap@x.com", hitCount: 2, lastHitAt: ISO, status: "blocklisted" },
    ];
    const screen = await render(<SpamTrapGuardCard />);
    expect(
      screen.getByText(/3 trap hits in 30 days · 2 blocklisted · 1 still eligible/),
    ).toBeTruthy();
    expect(screen.getByText("trap@x.com")).toBeTruthy();
    expect(screen.getByText("hits")).toBeTruthy();
  });

  it("never renders a failed stats read as a clean guard", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockTrapStats.isError = true;
    const screen = await render(<SpamTrapGuardCard />);
    expect(screen.getByText(/the guard's real state is unknown/)).toBeTruthy();
    expect(screen.queryByText(/No spam-trap hits/)).toBeNull();
  });
});

describe("SoftBounceRecoveryCard", () => {
  const STATS = {
    eligibleSuppressionsNow: 4,
    disabledCount: 7,
    recoveryWindowDays: 30,
  };

  it("gives an admin run-now behind a consequence-naming confirm", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockSoftStats.data = STATS;
    const screen = await render(<SoftBounceRecoveryCard />);
    fireEvent.press(screen.getByText("Run recovery now"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockConfirm.mock.calls[0]?.[0]).toMatchObject({
      consequence: "4 suppressions would be lifted now.",
    });
    await waitFor(() => expect(mockRunSoft.mutate).toHaveBeenCalled());
  });

  it("shows a viewer the stats with no run verb", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockSoftStats.data = STATS;
    const screen = await render(<SoftBounceRecoveryCard />);
    expect(screen.getByText(/4 suppressions eligible to lift now/)).toBeTruthy();
    expect(screen.queryByText("Run recovery now")).toBeNull();
  });
});

describe("AuthChecksCard", () => {
  const ROW = {
    domain: "acme.com",
    checks: {
      spf: { status: "pass" },
      dkim: { status: "pass" },
      dmarc: { status: "fail" },
      bimi: { status: "none" },
      ptr: { status: "pass" },
    },
  };

  it("is omitted entirely below admin", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    const screen = await render(<AuthChecksCard />);
    expect(screen.toJSON()).toBeNull();
  });

  it("arms the DNS walk only on press, then renders the verdict matrix", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockAuthQuery.data = [ROW];
    const screen = await render(<AuthChecksCard />);
    expect(mockAuthArmed.every((armed) => armed === false)).toBe(true);
    fireEvent.press(screen.getByText("Run checks"));
    await waitFor(() => expect(mockAuthArmed).toContain(true));
    expect(screen.getByText("acme.com")).toBeTruthy();
    expect(screen.getByText("DMARC fail")).toBeTruthy();
    expect(screen.getByText("BIMI —")).toBeTruthy();
  });

  it("renders a 503 as 'not configured', a different sentence from failure", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockAuthQuery.isError = true;
    mockAuthQuery.error = new EvidenceError(
      { status: 503, message: "upstream" } as ConstructorParameters<
        typeof EvidenceError
      >[0],
      "x",
    );
    const screen = await render(<AuthChecksCard />);
    fireEvent.press(screen.getByText("Run checks"));
    expect(
      await screen.findByText(/isn't configured on this deployment/),
    ).toBeTruthy();
    expect(screen.queryByText(/couldn't be loaded/)).toBeNull();
  });
});

describe("CampaignPlacementCard", () => {
  const SENT = [
    { id: "c-1", name: "August promo", subject: "Hi", sent_at: ISO, status: "sent" },
  ];

  it("is omitted entirely below admin", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    const screen = await render(<CampaignPlacementCard />);
    expect(screen.toJSON()).toBeNull();
  });

  it("treats a 404 (null report) as a real no-seed-test answer and diagnoses on press", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockCampaigns.data = SENT;
    Object.assign(mockPlacement, { data: null, isPending: false });
    const screen = await render(<CampaignPlacementCard />);
    fireEvent.press(screen.getByText("August promo"));
    expect(await screen.findByText(/No seed test has reported/)).toBeTruthy();
    fireEvent.press(screen.getByText("Diagnose with AI"));
    expect(mockDiagnose.mutate).toHaveBeenCalledWith("c-1");
  });

  it("renders the placement mix once the report lands", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockCampaigns.data = SENT;
    Object.assign(mockPlacement, {
      isPending: false,
      data: {
        overallPct: { inbox: 0.72, spam: 0.18, promotions: 0.1 },
        totalInboxes: 20,
        providers: [{ provider: "gmail" }, { provider: "outlook" }],
      },
    });
    const screen = await render(<CampaignPlacementCard />);
    fireEvent.press(screen.getByText("August promo"));
    expect(await screen.findByText(/Inbox 72/)).toBeTruthy();
    expect(screen.getByText(/Spam 18/)).toBeTruthy();
    expect(screen.getByText(/Across 20 seed inboxes · 2 providers/)).toBeTruthy();
  });
});

describe("FeedbackTrailCard", () => {
  it("is omitted entirely below admin", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    const screen = await render(<FeedbackTrailCard />);
    expect(screen.toJSON()).toBeNull();
  });

  it("looks up only a valid address, on press, via the body-post mutation", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<FeedbackTrailCard />);
    // Each event must COMMIT before the next handler closes over its state —
    // this RTL version does not flush between synchronous fireEvent calls.
    fireEvent.changeText(
      screen.getByLabelText("Recipient address to look up"),
      "not-an-email",
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Recipient address to look up").props.value,
      ).toBe("not-an-email"),
    );
    fireEvent.press(screen.getByText("Look up trail"));
    expect(mockFeedback.mutate).not.toHaveBeenCalled();
    fireEvent.changeText(
      screen.getByLabelText("Recipient address to look up"),
      " person@x.com ",
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Recipient address to look up").props.value,
      ).toContain("person@x.com"),
    );
    fireEvent.press(screen.getByText("Look up trail"));
    await waitFor(() =>
      expect(mockFeedback.mutate).toHaveBeenCalledWith("person@x.com"),
    );
  });

  it("keeps an empty trail distinct from a failed lookup", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockFeedback.data = { bounces: [], complaints: [] };
    const screen = await render(<FeedbackTrailCard />);
    expect(
      screen.getByText(/No recorded bounces or complaints for that address/),
    ).toBeTruthy();
  });

  it("renders both trails, bounce class and complaint source included", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockFeedback.data = {
      bounces: [{ id: "b1", bounceType: "hard", esp: "ses", receivedAt: ISO }],
      complaints: [
        { id: "c1", complaintType: "abuse", esp: "sendgrid", receivedAt: ISO },
      ],
    };
    const screen = await render(<FeedbackTrailCard />);
    expect(screen.getByText("Bounce · hard")).toBeTruthy();
    expect(screen.getByText("Complaint · abuse")).toBeTruthy();
  });
});

describe("EqScoreCard", () => {
  it("is omitted below editor", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const screen = await render(<EqScoreCard />);
    expect(screen.toJSON()).toBeNull();
  });

  it("scores the draft only on press", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    const screen = await render(<EqScoreCard />);
    // Commit each event before the next — no flush between sync fireEvents.
    fireEvent.changeText(
      screen.getByLabelText("From address of the draft"),
      "me@acme.com",
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("From address of the draft").props.value,
      ).toBe("me@acme.com"),
    );
    fireEvent.changeText(
      screen.getByLabelText("Subject line of the draft"),
      "Hello",
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Subject line of the draft").props.value,
      ).toBe("Hello"),
    );
    fireEvent.press(screen.getByText("Score draft"));
    await waitFor(() =>
      expect(mockEq.mutate).toHaveBeenCalledWith({
        from: "me@acme.com",
        subject: "Hello",
        html: "",
      }),
    );
  });

  it("renders a skipped pillar as 'not scored', never zero", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    mockEq.data = {
      score: 71.4,
      grade: "B",
      content: {
        score: 80,
        weight: 1,
        reasons: [
          { code: "s", message: "Short subject", severity: "info", bucket: "content" },
        ],
      },
      auth: { score: 0, weight: 1, reasons: [] },
      reputation: { score: 55, weight: 1, reasons: [] },
      reasons: [],
      skippedSubScores: ["auth"],
    };
    const screen = await render(<EqScoreCard />);
    expect(screen.getByText("71")).toBeTruthy();
    expect(screen.getByText("Authentication: not scored")).toBeTruthy();
    expect(screen.queryByText("Authentication: 0")).toBeNull();
    expect(screen.getByText("Content: 80")).toBeTruthy();
  });
});

describe("BotOpensCard", () => {
  const SIGNATURES = [
    {
      id: "s1",
      label: "Apple MPP",
      pattern: "AppleMail",
      kind: "ua",
      enabled: true,
      isDefault: true,
    },
    {
      id: "s2",
      label: "Corp scanner",
      pattern: "CorpBot",
      kind: "ua",
      enabled: true,
      isDefault: false,
    },
  ];

  it("arms the open-history walk only on press", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const screen = await render(<BotOpensCard />);
    expect(mockBotArmed.every((armed) => armed === false)).toBe(true);
    fireEvent.press(screen.getByText("Check open quality"));
    await waitFor(() => expect(mockBotArmed).toContain(true));
  });

  it("renders the machine share and only custom signatures carry a remove verb", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockBotStats.data = {
      totalOpens: 29360,
      botOpens: 12040,
      humanOpens: 17320,
      since: ISO,
      bySignature: [{ label: "Apple MPP", opens: 9000 }],
    };
    mockBotSignatures.data = SIGNATURES;
    const screen = await render(<BotOpensCard />);
    fireEvent.press(screen.getByText("Check open quality"));
    expect(await screen.findByText(/41% of opens were machines/)).toBeTruthy();
    expect(screen.getByText("Apple MPP: 9000 opens")).toBeTruthy();
    expect(screen.getAllByText("Remove")).toHaveLength(1);
    expect(screen.getByText(/1 platform signature always appl/)).toBeTruthy();
    fireEvent.press(screen.getByText("Remove"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockDeleteSig.mutate).toHaveBeenCalledWith("s2", expect.anything()),
    );
  });

  it("gives a viewer the stats with no signature verbs", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockBotSignatures.data = SIGNATURES;
    const screen = await render(<BotOpensCard />);
    fireEvent.press(screen.getByText("Check open quality"));
    await waitFor(() => expect(screen.getByText("Corp scanner")).toBeTruthy());
    expect(screen.queryByText("Remove")).toBeNull();
    expect(screen.queryByText("Add a signature")).toBeNull();
  });
});

describe("ProvidersCard", () => {
  const CONNECTIONS = [
    {
      id: "p1",
      provider: "sendgrid",
      displayName: "SG prod",
      active: true,
      config: { webhook_token_hash: "abc", credential_ref: "vault-name" },
    },
  ];

  it("makes presence-only claims about stored secrets", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockProviders.data = CONNECTIONS;
    const screen = await render(<ProvidersCard />);
    expect(
      screen.getByText(/webhook token set · vault reference set/),
    ).toBeTruthy();
    expect(screen.queryByText(/abc/)).toBeNull();
    expect(screen.queryByText("vault-name")).toBeNull();
  });

  it("withholds every write verb from a viewer", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockProviders.data = CONNECTIONS;
    const screen = await render(<ProvidersCard />);
    expect(screen.queryByText("Pause")).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();
    expect(screen.queryByText("Connect a provider")).toBeNull();
  });

  it("admin removal is destructive-confirmed and names the consequence", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockProviders.data = CONNECTIONS;
    const screen = await render(<ProvidersCard />);
    fireEvent.press(screen.getByText("Remove"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockConfirm.mock.calls[0]?.[0]).toMatchObject({ destructive: true });
    await waitFor(() =>
      expect(mockDeleteProv.mutate).toHaveBeenCalledWith("p1", expect.anything()),
    );
  });
});

describe("VerificationPolicyCard", () => {
  const CREDITS = {
    provider: "kickbox",
    balance: null,
    totals: {
      verified: 10,
      creditsSpent: 120,
      localFiltered: 5,
      cacheHits: 2,
      creditsSaved: 40,
    },
    note: "",
  };

  it("never asks for the policy below admin, and says whose lever it is", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockCredits.data = CREDITS;
    const screen = await render(<VerificationPolicyCard />);
    expect(mockPolicyEnabled.every((enabled) => enabled === false)).toBe(true);
    expect(screen.getByText(/workspace-admin territory/)).toBeTruthy();
    expect(screen.queryByLabelText("Form signups verification mode")).toBeNull();
  });

  it("keeps a null balance as 'not reported', never zero", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockCredits.data = CREDITS;
    const screen = await render(<VerificationPolicyCard />);
    expect(screen.getByText(/kickbox: balance not reported/)).toBeTruthy();
    expect(screen.queryByText(/0 credits left/)).toBeNull();
  });

  it("renders both gates for an admin and mutates the changed one", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockCredits.data = CREDITS;
    mockPolicyQuery.data = { policy: { formsMode: "off", importMode: "local" } };
    const screen = await render(<VerificationPolicyCard />);
    expect(mockPolicyEnabled).toContain(true);
    fireEvent.press(screen.getAllByText("Full")[0]!);
    expect(mockSetMode.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ gate: "forms", mode: "full" }),
      expect.anything(),
    );
  });
});

describe("ControlPanelCard", () => {
  it("arms the four reads only when expanded", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const screen = await render(<ControlPanelCard />);
    expect(mockCtlArmed.every((armed) => armed === false)).toBe(true);
    fireEvent.press(screen.getByText("Show infrastructure"));
    await waitFor(() => expect(mockCtlArmed).toContain(true));
  });

  it("lets one dead read fail alone while the other sections render", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    Object.assign(mockCtlDomains, { isError: true, isPending: false });
    Object.assign(mockCtlClick, {
      isPending: false,
      data: {
        trackingDomain: "click.acme.com",
        status: "active",
        sslStatus: "active",
        lastUntrackedCount: 3,
      },
    });
    Object.assign(mockCtlRouting, {
      isPending: false,
      data: {
        strategy: "balanced",
        effectiveDedicatedPercent: 60,
        effectiveSharedPercent: 40,
        lastEvaluatedAt: ISO,
      },
    });
    Object.assign(mockCtlEnt, {
      isPending: false,
      data: {
        planTier: "scale",
        inboxTestsRemaining: 8,
        inboxTestsMonthly: 10,
        renderPreviewsRemaining: 90,
        renderPreviewsMonthly: 100,
      },
    });
    const screen = await render(<ControlPanelCard />);
    fireEvent.press(screen.getByText("Show infrastructure"));
    expect(
      await screen.findByText("Domain setups couldn't be loaded."),
    ).toBeTruthy();
    expect(screen.getByText(/last scan found 3 untracked links/)).toBeTruthy();
    expect(screen.getByText(/60% dedicated \/ 40% shared/)).toBeTruthy();
    expect(screen.getByText(/8 of 10 inbox tests left/)).toBeTruthy();
  });
});

describe("HygienePlaybooksCard", () => {
  it("ships all three playbooks collapsed, expanding on press", async () => {
    const screen = await render(<HygienePlaybooksCard />);
    expect(screen.getByText("Sunset flow")).toBeTruthy();
    expect(
      screen.getByText("Apple Mail Privacy Protection (MPP)"),
    ).toBeTruthy();
    expect(screen.getByText("Bounce-class playbook")).toBeTruthy();
    expect(screen.queryByText(/Identify: /)).toBeNull();
    fireEvent.press(screen.getByText("Sunset flow"));
    expect(await screen.findByText(/Identify: /)).toBeTruthy();
  });
});

describe("WarmupOpsControls", () => {
  it("remove confirms with the domain as the typed phrase", async () => {
    const screen = await render(
      <WarmupOpsControls selectedDomain="mail.acme.com" hasPlanForSelected />,
    );
    fireEvent.press(screen.getByText("Remove this ramp"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockConfirm.mock.calls[0]?.[0]).toMatchObject({
      confirmPhrase: "mail.acme.com",
      destructive: true,
    });
    await waitFor(() =>
      expect(mockDeleteWarmup.mutate).toHaveBeenCalledWith(
        "mail.acme.com",
        expect.anything(),
      ),
    );
  });

  it("blocks an invalid draft and lowercases the domain on create", async () => {
    const screen = await render(
      <WarmupOpsControls selectedDomain="" hasPlanForSelected={false} />,
    );
    fireEvent.press(screen.getByText("Start a ramp"));
    fireEvent.press(await screen.findByText("Start warm-up"));
    expect(mockCreateWarmup.mutate).not.toHaveBeenCalled();
    // Commit each event before the next — no flush between sync fireEvents.
    fireEvent.changeText(
      screen.getByLabelText("Domain to warm up"),
      "Mail.Acme.com",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Domain to warm up").props.value).toBe(
        "Mail.Acme.com",
      ),
    );
    fireEvent.changeText(
      screen.getByLabelText("Target daily send volume"),
      "5000",
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Target daily send volume").props.value,
      ).toBe("5000"),
    );
    fireEvent.changeText(screen.getByLabelText("Ramp length in days"), "14");
    await waitFor(() =>
      expect(screen.getByLabelText("Ramp length in days").props.value).toBe(
        "14",
      ),
    );
    fireEvent.press(screen.getByText("Start warm-up"));
    await waitFor(() =>
      expect(mockCreateWarmup.mutate).toHaveBeenCalledWith(
        { domain: "mail.acme.com", targetDaily: 5000, days: 14 },
        expect.anything(),
      ),
    );
  });
});
