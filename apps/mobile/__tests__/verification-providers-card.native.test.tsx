/**
 * P3 — "verification vendor/provider configuration (ZeroBounce/Kickbox)".
 *
 * The phone could already read the verification MODE and the credit meter but
 * not the vendor row underneath them, so "full mode with a rejected ZeroBounce
 * key" looked exactly like "full mode working". This suite pins the four
 * things that rot silently once nobody renders the card:
 *
 *  - the read is ADMIN-scoped server-side, so below admin the query is not
 *    even armed (a viewer must never buy a guaranteed 403);
 *  - NOTHING credential-shaped reaches the tree — the view is built here by
 *    the REAL parser from a wire payload that DOES carry `credential_ref`,
 *    so the assertion is about the pipeline, not about a hand-made object;
 *  - a failed read is a failure sentence, never an implied "no vendor";
 *  - both writes go through a confirm that names the consequence, and a
 *    failed write renders the SERVER's sentence rather than the generic
 *    status copy that would invite a pointless retry.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";

const mockArmed: boolean[] = [];
const mockQuery: { data: unknown; isError: boolean } = {
  data: undefined,
  isError: false,
};
const mockSetEnabled = { mutate: jest.fn(), isPending: false };
const mockRemove = { mutate: jest.fn(), isPending: false };
const mockConfirm = jest.fn<(options: unknown) => Promise<boolean>>(
  async () => true,
);
const mockToast = jest.fn();

jest.mock("@/hooks/useVerificationProviders", () => ({
  useVerificationProviders: (enabled: boolean) => {
    mockArmed.push(enabled);
    return mockQuery;
  },
  useSetVerificationProviderEnabled: () => mockSetEnabled,
  useRemoveVerificationProvider: () => mockRemove,
}));
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => mockConfirm,
}));
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: mockToast, dismiss: jest.fn() }),
}));

// eslint-disable-next-line import/first
import { VerificationProvidersError } from "@/api/verificationProviders";
// eslint-disable-next-line import/first
import { VerificationProvidersCard } from "@/components/deliverability/VerificationProvidersCard";
// eslint-disable-next-line import/first
import * as Gate from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import { parseVerificationProviders } from "@/lib/verificationProviders";

const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

/** The credential handle the server DOES send back on every row. */
const CREDENTIAL = "zb-cred-0f9c1b7e";

/** A wire payload shaped exactly like GET /api/v1/verification/providers. */
function wire(overrides: Record<string, unknown> = {}) {
  return {
    providers: [
      {
        provider: "zerobounce",
        credential_ref: CREDENTIAL,
        enabled: true,
        settings: { ip_address: "203.0.113.9", cache_ttl_days: 14 },
        last_balance: 12400,
        last_balance_at: "2026-09-01T10:00:00Z",
        updated_at: "2026-09-01T10:00:00Z",
        ...overrides,
      },
    ],
    available: ["zerobounce", "kickbox"],
  };
}

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  mockArmed.length = 0;
  mockSetEnabled.mutate.mockReset();
  mockRemove.mutate.mockReset();
  mockToast.mockReset();
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  Object.assign(mockQuery, { data: undefined, isError: false });
});

describe("VerificationProvidersCard — role floor", () => {
  it.each(["viewer", "editor"])(
    "renders nothing for a %s and never arms the admin-only read",
    async (role) => {
      gateHarness.__setOnlineGateForTests({ effectiveRole: role });
      mockQuery.data = parseVerificationProviders(wire());
      const screen = await render(<VerificationProvidersCard />);
      expect(screen.queryByText("Verification vendor")).toBeNull();
      // The whole point: asking as a non-admin buys a guaranteed 403.
      expect(mockArmed.every((armed) => armed === false)).toBe(true);
    },
  );

  it("arms the read for an admin", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders(wire());
    await render(<VerificationProvidersCard />);
    expect(mockArmed).toContain(true);
  });
});

describe("VerificationProvidersCard — what it shows", () => {
  it("names the enabled vendor and its dated balance", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders(wire());
    const screen = await render(<VerificationProvidersCard />);
    expect(
      screen.getByText(
        "ZeroBounce is the vendor verifying addresses for this workspace.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("ZeroBounce")).toBeTruthy();
    expect(screen.getByText("enabled")).toBeTruthy();
    expect(
      screen.getByText("Enabled · 12,400 credits at the last check."),
    ).toBeTruthy();
  });

  it("NEVER puts the credential handle or its settings into the tree", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders(wire());
    const screen = await render(<VerificationProvidersCard />);
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).not.toContain(CREDENTIAL);
    expect(tree).not.toContain("credential");
    // The tuned settings ride the write back to the server but are not the
    // phone's business to display either.
    expect(tree).not.toContain("203.0.113.9");
  });

  it("says no mailbox is probed when the configured vendor is switched off", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders(wire({ enabled: false }));
    const screen = await render(<VerificationProvidersCard />);
    expect(
      screen.getByText(
        "No vendor is enabled, so only the free local syntax and domain checks run — no mailbox is probed.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("off")).toBeTruthy();
  });

  it("renders a null balance as unreported rather than as zero credits", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders(
      wire({ last_balance: undefined }),
    );
    const screen = await render(<VerificationProvidersCard />);
    expect(
      screen.getByText("Enabled · balance not reported."),
    ).toBeTruthy();
    expect(screen.queryByText(/0 credits/u)).toBeNull();
  });

  it("renders the server's sanitised connection failure verbatim", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders(
      wire({ last_error: "The provider rejected the configured account." }),
    );
    const screen = await render(<VerificationProvidersCard />);
    expect(
      screen.getByText("The provider rejected the configured account."),
    ).toBeTruthy();
  });

  it("never renders a failed read as 'no vendor configured'", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.isError = true;
    const screen = await render(<VerificationProvidersCard />);
    expect(
      screen.getByText(/which vendor verifies addresses — if any — is unknown/u),
    ).toBeTruthy();
    expect(screen.queryByText("Enable")).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("refuses both writes offline and says why", async () => {
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "owner",
      enabled: false,
    });
    mockQuery.data = parseVerificationProviders(wire());
    const screen = await render(<VerificationProvidersCard />);
    expect(
      screen.getByText(/decides whether mailboxes are probed and credits spent/u),
    ).toBeTruthy();
    expect(screen.queryByText("Disable")).toBeNull();
  });

  it("does not offer a create verb when nothing is configured", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders({
      providers: [],
      available: ["zerobounce", "kickbox"],
    });
    const screen = await render(<VerificationProvidersCard />);
    expect(
      screen.getByText(/ZeroBounce and Kickbox can be connected/u),
    ).toBeTruthy();
    expect(screen.queryByText("Enable")).toBeNull();
  });
});

describe("VerificationProvidersCard — the two writes", () => {
  it("confirms a disable with the silent-downgrade consequence", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders(wire());
    const screen = await render(<VerificationProvidersCard />);
    await fireEvent.press(screen.getByLabelText("Disable ZeroBounce"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockConfirm.mock.calls[0]?.[0]).toMatchObject({
      title: "Disable ZeroBounce?",
      destructive: true,
      consequence:
        "ZeroBounce will stop verifying addresses. Only the free local syntax and domain checks will run, so no mailbox is probed until a vendor is enabled again.",
    });
    await waitFor(() =>
      expect(mockSetEnabled.mutate).toHaveBeenCalledWith(
        { provider: "zerobounce", enabled: false },
        expect.anything(),
      ),
    );
  });

  it("does not write when the confirm is declined", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockConfirm.mockResolvedValue(false);
    mockQuery.data = parseVerificationProviders(wire({ enabled: false }));
    const screen = await render(<VerificationProvidersCard />);
    await fireEvent.press(screen.getByLabelText("Enable ZeroBounce"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockSetEnabled.mutate).not.toHaveBeenCalled();
  });

  it("states the paid consequence before enabling", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders(wire({ enabled: false }));
    const screen = await render(<VerificationProvidersCard />);
    await fireEvent.press(screen.getByLabelText("Enable ZeroBounce"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(String(mockConfirm.mock.calls[0]?.[0])).not.toBe("undefined");
    expect(
      (mockConfirm.mock.calls[0]?.[0] as { consequence: string }).consequence,
    ).toContain("spends one of this workspace's provider credits");
  });

  it("gates removal behind typing the vendor name", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders(wire());
    const screen = await render(<VerificationProvidersCard />);
    await fireEvent.press(screen.getByLabelText("Remove ZeroBounce"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockConfirm.mock.calls[0]?.[0]).toMatchObject({
      confirmPhrase: "ZeroBounce",
      destructive: true,
    });
    await waitFor(() =>
      expect(mockRemove.mutate).toHaveBeenCalledWith(
        "zerobounce",
        expect.anything(),
      ),
    );
  });

  it("shows the server's sentence and the escape hatch when the key probe blocks a disable", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockQuery.data = parseVerificationProviders(wire());
    const screen = await render(<VerificationProvidersCard />);
    await fireEvent.press(screen.getByLabelText("Disable ZeroBounce"));
    await waitFor(() => expect(mockSetEnabled.mutate).toHaveBeenCalled());

    const options = mockSetEnabled.mutate.mock.calls[0]?.[1] as {
      onError: (err: unknown) => void;
    };
    // The REAL error class, carrying the real 412 the handler writes when
    // Store.ConfigureProvider's pre-write credential probe is refused.
    options.onError(
      new VerificationProvidersError(
        {
          status: 412,
          code: "verification_provider_unauthorized",
          message:
            "The verification provider rejected the configured API key. Update it in workspace settings.",
        },
        "Couldn't change the verification vendor.",
      ),
    );

    const message = String(
      (mockToast.mock.calls.at(-1)?.[0] as { message: string }).message,
    );
    expect(message).toContain("rejected the configured API key");
    expect(message).toContain("Removing the vendor does not contact the provider");
    // The generic status copy would have said this instead.
    expect(message).not.toContain("Something went wrong loading this");
  });
});
