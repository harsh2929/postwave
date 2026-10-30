/**
 * The controls that STOP things must survive a hostile payload.
 *
 * WHY THIS FILE EXISTS. 44 of the 57 components that fire a write had never
 * been mounted by any test. That is the same population the helpdesk screens
 * were in, and mounting those for the first time found a crash in each — but
 * these are WRITES, so a crash catches an operator mid-action, on the controls
 * they reach for when something is already going wrong:
 *
 *   - the sending kill switch, which halts every send in the workspace;
 *   - the reputation controls, reached during a spam-trap or attack incident;
 *   - device and secret revocation, reached after a suspected compromise.
 *
 * Each case here is a payload the WIRE can actually produce — Go's `omitempty`
 * dropping a field, an envelope where an array was expected, an absent
 * upstream — not an invented one.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

import { AssuranceLegalHoldPanel } from "@/components/compliance/AssuranceLegalHoldPanel";
import { IngestSecretsPanel } from "@/components/conversions/IngestSecretsPanel";
import { ReputationResponseCard } from "@/components/deliverability/ReputationResponseCard";
import { SendingKillSwitchCard } from "@/components/deliverability/SendingKillSwitchCard";
import { TrustedDevicesSection } from "@/components/settings/TrustedDevicesSection";
import { ActiveDevicesSection } from "@/components/settings/ActiveDevicesSection";
import { PasskeysSection } from "@/components/settings/PasskeysSection";
import { OutboundWebhooksSection } from "@/components/settings/OutboundWebhooksSection";
import { DelegatePicker } from "@/components/settings/DelegatePicker";
import { InboxRealityTestsPanel } from "@/components/deliverability/InboxRealityTestsPanel";
import { ReplyMailboxPanel } from "@/components/deliverability/ReplyMailboxPanel";
import { VerificationJobsPanel } from "@/components/deliverability/VerificationJobsPanel";
import { OutboxDlqSection } from "@/components/diagnostics/OutboxDlqSection";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetOnlineGateForTests();
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

function settled(value: unknown) {
  return {
    data: value,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: value })),
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => undefined),
  };
}

function online(role = "admin") {
  hookHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: role,
    online: true,
  });
}

describe("sending kill switch", () => {
  it("mounts with a normal control", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled({ paused: false }));
    expect(() =>
      render(<SendingKillSwitchCard effectiveRole="admin" />, { wrapper }),
    ).not.toThrow();
  });

  it("renders nothing rather than guessing when the control is absent", async () => {
    // A missing control must not render a switch whose position is a guess:
    // showing "sending is active" when the state is unknown is the one lie
    // this card cannot afford.
    online();
    queryHarness.__setQueryResultForTests(settled(null));
    await render(<SendingKillSwitchCard effectiveRole="admin" />, { wrapper });
    // The card's own affordances must all be absent — the reason field and the
    // hold control. (`toJSON()` still shows the test wrapper, so assert on the
    // card's content instead.)
    expect(
      screen.queryByPlaceholderText(/Why are you holding sending/u),
    ).toBeNull();
    expect(screen.queryByText(/Hold all sending/u)).toBeNull();
  });

  it.each([
    ["a bare object", {}],
    ["a paged envelope", { items: [], total: 0 }],
    ["an array", []],
    ["a string", "paused"],
    ["a number", 1],
  ])("survives %s from the wire", async (_label, payload) => {
    online();
    queryHarness.__setQueryResultForTests(settled(payload as never));
    expect(() =>
      render(<SendingKillSwitchCard effectiveRole="admin" />, { wrapper }),
    ).not.toThrow();
  });

  it("survives a null effectiveRole", async () => {
    // The gate can hand back null before the session resolves.
    online();
    queryHarness.__setQueryResultForTests(settled({ paused: true }));
    expect(() =>
      render(<SendingKillSwitchCard effectiveRole={null} />, { wrapper }),
    ).not.toThrow();
  });
});

/**
 * `?? []` is a NULLISH guard: it catches null and undefined and nothing else,
 * so a TRUTHY non-array sails past it into `.map`/`.filter`. Go handlers
 * legitimately produce all of these — `omitempty` dropping a list, a paged
 * envelope where a bare array was expected, an SPA fallback for an absent
 * upstream. This is the shape that crashed the helpdesk queue and thread.
 */
const HOSTILE: [string, unknown][] = [
  ["a bare object", {}],
  ["a paged envelope", { items: [], total: 0 }],
  ["undefined", undefined],
  ["null", null],
  ["a string", "x"],
];

describe("reputation controls survive a hostile blocklist", () => {
  // Reached during a spam-trap or attack incident: the worst moment to crash.
  it.each(HOSTILE)("does not crash on %s", async (_label, payload) => {
    online();
    queryHarness.__setQueryResultForTests(settled(payload));
    expect(() => render(<ReputationResponseCard />, { wrapper })).not.toThrow();
  });
});

describe("trusted devices survive a hostile device list", () => {
  // Reached after a suspected compromise, to revoke a device.
  it.each(HOSTILE)("does not crash on %s", async (_label, payload) => {
    online();
    queryHarness.__setQueryResultForTests(settled(payload));
    expect(() => render(<TrustedDevicesSection />, { wrapper })).not.toThrow();
  });

  it("does not crash when `devices` itself is a non-array", async () => {
    online();
    queryHarness.__setQueryResultForTests(settled({ devices: { 0: {} } }));
    expect(() => render(<TrustedDevicesSection />, { wrapper })).not.toThrow();
  });
});

describe("ingest secrets survive a hostile secret list", () => {
  // Reached to revoke a leaked HMAC signing key.
  it.each(HOSTILE)("does not crash on %s", async (_label, payload) => {
    online();
    queryHarness.__setQueryResultForTests(settled(payload));
    expect(() => render(<IngestSecretsPanel />, { wrapper })).not.toThrow();
  });

  it("distinguishes private HMAC keys and locks the exact v2 wire contract", async () => {
    online();
    queryHarness.__setQueryResultForTests({
      ...settled({
        pages: [
          {
            items: [
              {
                keyId: "live-key-id",
                label: "Production checkout",
                createdAt: "2026-08-30T10:00:00Z",
                revokedAt: null,
                identityProjectionStatus: "pending",
                identityProjectionErrorCode: null,
                identityProjectionUpdatedAt: "2026-08-30T10:00:00Z",
              },
              {
                keyId: "retired-key-id",
                label: "Old checkout",
                createdAt: "2026-08-01T10:00:00Z",
                revokedAt: "2026-08-29T10:00:00Z",
                identityProjectionStatus: "failed",
                identityProjectionErrorCode: "secret_unavailable",
                identityProjectionUpdatedAt: "2026-08-29T09:00:00Z",
              },
            ],
          },
        ],
        pageParams: [undefined],
      }),
      fetchNextPage: jest.fn(async () => undefined),
      hasNextPage: false,
      isFetchingNextPage: false,
    });
    await render(<IngestSecretsPanel />, { wrapper });

    expect(screen.getByText("Trusted server conversion ingest")).toBeTruthy();
    expect(
      screen.getByText(/separate from publishable browser tracking keys/u),
    ).toBeTruthy();
    expect(
      screen.getByText("X-Postwave-Signature: keyid=<id>,v2=<hex>"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "email_hmac_sha256 = HMAC-SHA256(signing secret, lower(trim(email)))",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/never send identity.email/u)).toBeTruthy();
    expect(screen.getByText(/web or desktop admin/u)).toBeTruthy();
    expect(screen.getByText("email HMAC pending")).toBeTruthy();
    expect(
      screen.getByText(/return 503 until projection is ready/u),
    ).toBeTruthy();
    expect(screen.getByText("email HMAC failed")).toBeTruthy();
    expect(
      screen.getByText(/issue a replacement on web or desktop/u),
    ).toBeTruthy();
    expect(
      screen.getByText(/Click-ID and external-ID-only events are unaffected/u),
    ).toBeTruthy();
    expect(screen.getAllByText("Revoke key")).toHaveLength(1);
    expect(screen.getByText("revoked")).toBeTruthy();
  });

  it("loads the next bounded register page explicitly", async () => {
    online();
    const fetchNextPage = jest.fn(async () => undefined);
    queryHarness.__setQueryResultForTests({
      ...settled({ pages: [{ items: [] }], pageParams: [undefined] }),
      fetchNextPage,
      hasNextPage: true,
      isFetchingNextPage: false,
    });
    await render(<IngestSecretsPanel />, { wrapper });

    fireEvent.press(screen.getByText("Load more server keys"));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});

describe("legal hold survives a hostile hold list", () => {
  // A legal hold suspends erasure; a crash here hides a statutory obligation.
  it.each(HOSTILE)("does not crash on %s", async (_label, payload) => {
    online();
    queryHarness.__setQueryResultForTests(settled(payload));
    expect(() =>
      render(<AssuranceLegalHoldPanel />, { wrapper }),
    ).not.toThrow();
  });
});

/**
 * The remaining write components that take no props, mounted for the first
 * time. Each is a surface an operator uses to CHANGE something, and each
 * iterates data straight off the wire.
 */
describe.each([
  ["active devices (session revocation)", ActiveDevicesSection],
  ["passkeys", PasskeysSection],
  ["outbound webhooks", OutboundWebhooksSection],
  ["delegate picker", DelegatePicker],
  ["inbox reality tests", InboxRealityTestsPanel],
  ["reply mailboxes", ReplyMailboxPanel],
  ["verification jobs", VerificationJobsPanel],
  ["outbox DLQ", OutboxDlqSection],
])("%s survives the wire", (_label, Component) => {
  it.each(HOSTILE)("does not crash on %s", async (_case, payload) => {
    online();
    queryHarness.__setQueryResultForTests(settled(payload));
    expect(() => render(<Component />, { wrapper })).not.toThrow();
  });
});

describe("verification job spend visibility", () => {
  it("shows an explicit unknown-spend warning when the read fails", async () => {
    online();
    queryHarness.__setQueryResultForTests({
      ...settled(undefined),
      data: undefined,
      error: new Error("unavailable"),
      isError: true,
      isSuccess: false,
    });
    await render(<VerificationJobsPanel />, { wrapper });
    expect(screen.getByText("Verification status unavailable")).toBeTruthy();
    expect(screen.getByText(/active provider spend is unknown/u)).toBeTruthy();
  });

  it("preserves last known active jobs when a refresh fails", async () => {
    online();
    queryHarness.__setQueryResultForTests({
      ...settled([
        {
          id: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
          status: "running",
          total: 10,
          processed: 3,
          createdAt: "2026-08-29T00:00:00Z",
        },
      ]),
      error: new Error("refresh failed"),
      isError: true,
      isSuccess: false,
    });
    await render(<VerificationJobsPanel />, { wrapper });
    expect(screen.getByText("10 addresses")).toBeTruthy();
    expect(
      screen.getByText(/Last known active jobs remain below/u),
    ).toBeTruthy();
  });
});
