import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ReplyMailboxPanel } from "@/components/deliverability/ReplyMailboxPanel";
import * as Gate from "@/hooks/useOnlineQueryGate";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const mailbox = {
  id: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
  label: "Support inbox",
  host: "imap.example.com",
  port: 993,
  useTLS: true,
  folder: "INBOX",
  usernameSecretRef:
    "env:POSTWAVE_REPLY_IMAP_TENANT_018F47F29F257F738EC63FD483EB51DD_USER",
  passwordSecretRef:
    "env:POSTWAVE_REPLY_IMAP_TENANT_018F47F29F257F738EC63FD483EB51DD_PASSWORD",
  enabled: false,
  lastPolledAt: "",
  lastError: "",
  securityQuarantinedAt: "",
  securityQuarantineReason: "",
};

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

function settled(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data })),
  };
}

function gate(enabled: boolean, role = "admin") {
  gateHarness.__setOnlineGateForTests({
    enabled,
    tenantId: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
    effectiveRole: role,
  });
}

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
});

describe("ReplyMailboxPanel", () => {
  it("renders an authoritative empty state and the desk creation handoff", async () => {
    gate(true);
    queryHarness.__setQueryResultForTests(settled([]));

    await render(<ReplyMailboxPanel />, { wrapper });

    expect(
      screen.getByText("No reply mailboxes are registered in this workspace."),
    ).toBeTruthy();
    expect(screen.getByText(/web or desktop administrator surface/u)).toBeTruthy();
  });

  it("never presents a failed or malformed read as empty", async () => {
    gate(true);
    queryHarness.__setQueryResultForTests({
      ...settled(undefined),
      data: { items: [] },
      error: new Error("bad envelope"),
      isError: true,
      isSuccess: false,
    });

    await render(<ReplyMailboxPanel />, { wrapper });

    expect(screen.getByText(/could not be verified/u)).toBeTruthy();
    expect(screen.queryByText(/No reply mailboxes are registered/u)).toBeNull();
    expect(screen.getByLabelText("Retry loading reply mailboxes")).toBeTruthy();
  });

  it("keeps last-loaded rows visible offline and disables every write", async () => {
    gate(false);
    queryHarness.__setQueryResultForTests(settled([mailbox]));

    await render(<ReplyMailboxPanel />, { wrapper });

    expect(screen.getByText("Support inbox")).toBeTruthy();
    expect(screen.getByText(/Last-loaded rows may be stale/u)).toBeTruthy();
    expect(
      screen.getByLabelText("Start polling Support inbox").props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText("Remove Support inbox").props.accessibilityState
        .disabled,
    ).toBe(true);
  });

  it("shows quarantine truth and prevents re-enabling the legacy row", async () => {
    gate(true);
    queryHarness.__setQueryResultForTests(
      settled([
        {
          ...mailbox,
          useTLS: false,
          securityQuarantinedAt: "2026-08-30T00:00:00Z",
          securityQuarantineReason:
            "legacy_insecure_transport_or_secret_reference",
        },
      ]),
    );

    await render(<ReplyMailboxPanel />, { wrapper });

    expect(screen.getByText(/Security quarantine:/u)).toBeTruthy();
    expect(
      screen.getByLabelText("Start polling Support inbox").props
        .accessibilityState.disabled,
    ).toBe(true);
  });
});
