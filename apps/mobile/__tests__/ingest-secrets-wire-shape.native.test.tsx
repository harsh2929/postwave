/**
 * What the signed-ingest key panel SAYS when the register has drifted.
 *
 * The admin opens this panel to revoke a leaked HMAC key. A server that adds
 * one field to a key row during a rolling deploy makes the strict row codec
 * refuse the whole register (ROW_KEYS rejects unknown keys). That refusal used
 * to be a bare Error, so the panel told the operator "Something went wrong
 * loading this" — a network blip — and never that updating the app is what
 * helps. The error here comes from the REAL parser, not a hand-built one.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";
import { IngestSecretsPanel } from "@/components/conversions/IngestSecretsPanel";
import { parseIngestSecrets } from "@/lib/ingestSecrets";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
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

function failedWith(error: unknown) {
  gateHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: "admin",
    online: true,
  });
  queryHarness.__setQueryResultForTests({
    data: undefined,
    error,
    isError: true,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({})),
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isFetchingNextPage: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => undefined),
  });
}

function driftedRegisterError(): unknown {
  try {
    parseIngestSecrets({
      items: [
        {
          key_id: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
          label: "Shopify",
          created_at: "2026-08-30T10:00:00Z",
          identity_projection_status: "ready",
          identity_projection_updated_at: "2026-08-30T10:01:00Z",
          rotated_at: "2026-09-01T00:00:00Z",
        },
      ],
    });
  } catch (err) {
    return err;
  }
  throw new Error("the drifted register parsed; the fixture is stale");
}

describe("IngestSecretsPanel — a register this app version cannot read", () => {
  it("says the response is unreadable and points at an update, not at the network", async () => {
    failedWith(driftedRegisterError());
    await render(<IngestSecretsPanel />, { wrapper });

    expect(
      screen.getByText("Signed-ingest key register unavailable"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Moosewave sent a response this version of the app can't read. If this keeps happening, update the app.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Something went wrong loading this/u)).toBeNull();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("control: a dropped connection still reads as a loading failure", async () => {
    failedWith(new Error("socket hang up"));
    await render(<IngestSecretsPanel />, { wrapper });

    expect(
      screen.getByText("Something went wrong loading this. Please try again."),
    ).toBeTruthy();
    expect(screen.queryByText(/update the app/u)).toBeNull();
  });
});
