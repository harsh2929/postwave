/**
 * GpcSignalsCard — the render contract.
 *
 * The derivation is pinned in src/lib/gpcSignals.test.ts and the transport
 * in src/api/consentEvents.test.ts; this file pins what the compliance
 * reader meets:
 *
 *  - signals render with the known-subject figure and the loaded-rows scope;
 *  - the uncorrelated warning appears exactly when rows cannot correlate;
 *  - a clean window renders NOTHING (SarQueueBanner's philosophy);
 *  - a live 403 reads as the permission rule, other failures as a failure;
 *  - below admin the card is omitted entirely.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConsentEventsError } from "@/api/consentEvents";

type HookResult = {
  mayRead: boolean;
  query: { data: unknown; error: unknown; isError: boolean };
};

let mockHook: HookResult = {
  mayRead: true,
  query: { data: undefined, error: null, isError: false },
};

jest.mock("@/hooks/useGpcSignals", () => ({
  useGpcSignals: () => mockHook,
}));
// The mount test renders the whole compliance screen; its own queries ride
// the shared proxy (default: loading), which is all the card needs to sit
// beside the SAR queue.
jest.mock("@/hooks/useCompliance", () => require("./mocks/queryHooks.cjs"));

// eslint-disable-next-line import/first -- must follow the hook mock.
import { GpcSignalsCard } from "@/components/consent/GpcSignalsCard";
// eslint-disable-next-line import/first
import { CompliancePostureScreen } from "@/components/compliance/CompliancePostureScreen";
// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";

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

afterEach(() => {
  mockHook = {
    mayRead: true,
    query: { data: undefined, error: null, isError: false },
  };
});

describe("GpcSignalsCard", () => {
  it("renders the headline, warning and loaded-rows scope", async () => {
    mockHook.query.data = {
      signalRows: 4,
      knownSubjects: 2,
      uncorrelatedRows: 1,
    };
    await render(<GpcSignalsCard />, { wrapper });
    expect(
      screen.getByText(
        "4 GPC opt-out signals recorded in the last 30 days, from 2 known subjects.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/no stable subject ID or email/)).toBeTruthy();
    expect(screen.getByText(/most recent consent events/)).toBeTruthy();
  });

  it("omits the warning when every signal correlates", async () => {
    mockHook.query.data = {
      signalRows: 2,
      knownSubjects: 2,
      uncorrelatedRows: 0,
    };
    await render(<GpcSignalsCard />, { wrapper });
    expect(screen.queryByText(/no stable subject ID/)).toBeNull();
  });

  it("renders NOTHING for a clean window — no all-clear noise", async () => {
    mockHook.query.data = {
      signalRows: 0,
      knownSubjects: 0,
      uncorrelatedRows: 0,
    };
    await render(<GpcSignalsCard />, { wrapper });
    expect(screen.queryByText(/Global Privacy Control/i)).toBeNull();
  });

  it("reads a live 403 as a permission rule, not a generic failure", async () => {
    mockHook.query = {
      data: undefined,
      isError: true,
      error: new ConsentEventsError({ status: 403, message: "forbidden" }),
    };
    await render(<GpcSignalsCard />, { wrapper });
    expect(
      screen.getByText(/needs an owner or admin session/),
    ).toBeTruthy();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("says a failed read failed, rather than hiding as silence", async () => {
    mockHook.query = {
      data: undefined,
      isError: true,
      error: new Error("socket closed"),
    };
    await render(<GpcSignalsCard />, { wrapper });
    expect(screen.getByText(/Couldn't load GPC signals/)).toBeTruthy();
  });

  it("is MOUNTED on the compliance screen, beside the SAR queue", async () => {
    // The card exists only if the host screen renders it — an unmounted
    // component is a phantom capability. Owner session (auth-mock default),
    // signals present: the headline must appear inside the real screen.
    mockHook.query.data = {
      signalRows: 3,
      knownSubjects: 1,
      uncorrelatedRows: 2,
    };
    await render(
      <ToastProvider>
        <CompliancePostureScreen />
      </ToastProvider>,
      { wrapper },
    );
    expect(
      screen.getByText(
        "3 GPC opt-out signals recorded in the last 30 days, from 1 known subject.",
      ),
    ).toBeTruthy();
  });

  it("is omitted entirely below admin", async () => {
    mockHook = {
      mayRead: false,
      query: {
        data: { signalRows: 4, knownSubjects: 2, uncorrelatedRows: 1 },
        error: null,
        isError: false,
      },
    };
    await render(<GpcSignalsCard />, { wrapper });
    expect(screen.queryByText(/GPC/)).toBeNull();
  });
});
