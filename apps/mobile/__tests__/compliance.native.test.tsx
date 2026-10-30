import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import ComplianceRoute, {
  ErrorBoundary as ComplianceErrorBoundary,
} from "../app/(tabs)/compliance";
import { CompliancePostureScreen } from "../src/components/compliance/CompliancePostureScreen";
import { ToastProvider } from "../src/components/Toast";
import { COMPLIANCE_EVENTS_LIMIT } from "../src/lib/compliancePrograms";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useCompliance", () => require("./mocks/queryHooks.cjs"));

/**
 * The compliance monitor has five states a "does it render" test never
 * reaches, and each one is a place where the app could state something false
 * about a legal claim:
 *
 *   ROLE     — every /api/v1/compliance/* route is mounted behind
 *              apikeys.RequireScope(ScopeAdmin), which on the session path is
 *              an owner|admin role check. Rendering "nothing attested" for a
 *              viewer would be a claim about the WORKSPACE when the true
 *              statement is about the SESSION.
 *   NO DATE  — renewal_at is nullable and three supported frameworks have no
 *              renewal by nature. A missing date must never read as expired,
 *              and must never be back-filled from the framework's cadence.
 *   in_progress — synthesized by the server for a framework with NO ROW AT
 *              ALL (the package's only INSERT hard-codes 'attested'). "In
 *              progress" would claim work nobody recorded.
 *   HIPAA    — status "unsupported", never stored, and its events route is a
 *              fixed empty response. Counting it caps the workspace at n-1
 *              forever; fetching its ledger renders "nothing yet" for
 *              something that can never happen.
 *   NO HASH  — an attestation whose document_sha256 is still '' has no
 *              evidence pinned to it. A green "Attested" pill hides exactly
 *              that.
 */

const DAY = 86_400_000;

function iso(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY).toISOString();
}

function program(over: Record<string, unknown> = {}) {
  return {
    framework: "soc2",
    status: "attested",
    rawStatus: "attested",
    signedByEmail: "dana@example.com",
    signerName: "Acme Legal",
    documentPath: "s3://compliance/soc2-2026.pdf",
    documentSha256: "9f2c".repeat(16),
    notes: "",
    attestedAt: iso(-300),
    renewalAt: iso(200),
    updatedAt: iso(-300),
    ...over,
  };
}

const HIPAA = {
  framework: "hipaa",
  status: "unsupported",
  rawStatus: "unsupported",
  signedByEmail: "",
  signerName: "",
  documentPath: "",
  documentSha256: "",
  notes:
    "Moosewave does not offer a Business Associate Agreement and must not be used to upload, store, process, or send Protected Health Information (PHI)",
  attestedAt: "",
  renewalAt: "",
  updatedAt: "",
};

function ledgerEvent(over: Record<string, unknown> = {}) {
  return {
    id: "1",
    framework: "soc2",
    eventType: "renewed",
    rawEventType: "renewed",
    signedByEmail: "dana@example.com",
    counterSignedBy: "Acme Legal",
    documentPath: "s3://compliance/soc2-2026.pdf",
    documentSha256: "deadbeef",
    notes: "",
    at: iso(-30),
    ...over,
  };
}

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

/** The loaded happy path every test starts from, minus what it overrides. */
function loadPrograms(
  programs: Record<string, unknown>[],
  events: Record<string, unknown>[] = [],
) {
  queryHooks.__setHookResultForTests(
    "useCompliancePrograms",
    queryResult({ data: programs }),
  );
  queryHooks.__setHookResultForTests(
    "useComplianceEvents",
    queryResult({ data: events }),
  );
}

function renderScreen(
  Component: React.ComponentType = CompliancePostureScreen,
) {
  return render(
    React.createElement(ToastProvider, null, React.createElement(Component)),
    {
      wrapper: ({ children }) => (
        <SafeAreaProvider
          initialMetrics={{
            frame: { height: 844, width: 390, x: 0, y: 0 },
            insets: { bottom: 34, left: 0, right: 0, top: 47 },
          }}
        >
          {children}
        </SafeAreaProvider>
      ),
    },
  );
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
});

describe("compliance route file", () => {
  it("mounts the default export the router actually loads", async () => {
    loadPrograms([program()]);
    const result = await renderScreen(ComplianceRoute);
    expect(result.getByText("Compliance")).toBeTruthy();
  });

  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof ComplianceErrorBoundary).toBe("function");
  });
});

describe("role gate", () => {
  it("explains the role instead of claiming nothing is attested", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "viewer" } });
    loadPrograms([]);
    const result = await renderScreen();
    expect(result.getByText("Needs an owner or admin session")).toBeTruthy();
    expect(result.queryByText("No frameworks came back")).toBeNull();
  });

  it("denies an editor, because ScopeAdmin is not an editor-write scope", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "editor" } });
    loadPrograms([program()]);
    const result = await renderScreen();
    expect(result.getByText("Needs an owner or admin session")).toBeTruthy();
  });

  it("denies an api_key session, which never carries the admin scope", async () => {
    authStore.__setAuthStateForTests({ mode: "api_key" });
    loadPrograms([program()]);
    const result = await renderScreen();
    expect(result.getByText("Needs an owner or admin session")).toBeTruthy();
  });

  it("adds the 'your role changed' line only for a LIVE 403", async () => {
    queryHooks.__setHookResultForTests(
      "useCompliancePrograms",
      queryResult({ isError: true, error: { status: 403 } }),
    );
    const result = await renderScreen();
    expect(
      result.getByText(/The server refused this read just now/),
    ).toBeTruthy();
  });

  it("still shows the ordinary error state for a NON-403 failure", async () => {
    queryHooks.__setHookResultForTests(
      "useCompliancePrograms",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    const result = await renderScreen();
    expect(result.queryByText("Needs an owner or admin session")).toBeNull();
    expect(result.queryByText("No frameworks came back")).toBeNull();
  });
});

describe("a renewal date is a measurement, or it is an em-dash", () => {
  it("never reads a standing obligation as expired", async () => {
    // CAN-SPAM has no renewal cadence at all, so an absent renewal_at is
    // normal — not a lapse, and not a "due soon".
    loadPrograms([program({ framework: "can_spam", renewalAt: "" })]);
    const result = await renderScreen();
    expect(result.getByText("No renewal needed")).toBeTruthy();
    expect(result.queryByText("Lapsed")).toBeNull();
  });

  it("names the gap when a framework that DOES expire has no date", async () => {
    loadPrograms([program({ framework: "soc2", renewalAt: "" })]);
    const result = await renderScreen();
    expect(result.getByText("No renewal date")).toBeTruthy();
    expect(
      result.getByText(/normally renews every 12 months, and no renewal date/),
    ).toBeTruthy();
  });

  it("leads with what has already lapsed and names the denominator", async () => {
    loadPrograms([
      program({ framework: "soc2", renewalAt: iso(-9) }),
      program({ framework: "ccpa", renewalAt: iso(400) }),
    ]);
    const result = await renderScreen();
    expect(
      result.getByText("1 of 2 tracked frameworks is past its own renewal date."),
    ).toBeTruthy();
  });
});

describe("'in_progress' is never rendered as progress", () => {
  it("says no record came back, which is what the server actually means", async () => {
    loadPrograms([{ ...program(), status: "in_progress", attestedAt: "", renewalAt: "" }]);
    const result = await renderScreen();
    expect(result.getByText("No record")).toBeTruthy();
    expect(result.queryByText("In progress")).toBeNull();
    expect(
      result.getByText(/No attestation record came back for this framework/),
    ).toBeTruthy();
  });
});

describe("HIPAA", () => {
  it("is kept out of the denominator and sorted last", async () => {
    loadPrograms([HIPAA, program({ framework: "soc2", renewalAt: iso(400) })]);
    const result = await renderScreen();
    // 1 tracked, not 2 — HIPAA can never be attested to.
    expect(
      result.getByText(
        "All 1 tracked framework has an attestation on file, and none renews within 30 days.",
      ),
    ).toBeTruthy();
    expect(result.getByText(/HIPAA is excluded from these counts/)).toBeTruthy();
  });

  it("shows the server's own refusal instead of an empty ledger", async () => {
    loadPrograms([HIPAA]);
    const result = await renderScreen();
    // The only row, so it is the selected one.
    expect(result.getByText("Not supported")).toBeTruthy();
    expect(result.getByText(/There is no ledger for HIPAA/)).toBeTruthy();
    expect(result.queryByText("No entries recorded")).toBeNull();
  });
});

describe("evidence", () => {
  it("flags an attestation with no document hash", async () => {
    loadPrograms([program({ documentSha256: "" })]);
    const result = await renderScreen();
    expect(result.getByText("No document hash")).toBeTruthy();
    expect(
      result.getByText("Nothing pins the document that was signed."),
    ).toBeTruthy();
  });

  it("offers the hash as a copyable control when there is one", async () => {
    loadPrograms([program()]);
    const result = await renderScreen();
    expect(result.getByText("Document SHA-256 · tap to copy")).toBeTruthy();
    expect(result.queryByText("No document hash")).toBeNull();
  });

  it("discloses that a full ledger page may be a truncation", async () => {
    loadPrograms(
      [program()],
      Array.from({ length: COMPLIANCE_EVENTS_LIMIT }, (_, index) =>
        ledgerEvent({ id: String(index + 1) }),
      ),
    );
    const result = await renderScreen();
    expect(
      result.getByText(
        `The newest ${COMPLIANCE_EVENTS_LIMIT} entries — the server caps the ledger, so older ones are not shown.`,
      ),
    ).toBeTruthy();
  });

  it("never reads an empty ledger as a clean history", async () => {
    loadPrograms([program()], []);
    const result = await renderScreen();
    expect(result.getByText("No entries recorded")).toBeTruthy();
    expect(
      result.getByText(
        /An attestation made before the ledger existed would not appear here/,
      ),
    ).toBeTruthy();
  });
});

describe("selection", () => {
  it("lands on the most urgent framework, not on catalogue order", async () => {
    loadPrograms([
      program({ framework: "iso27001", renewalAt: iso(400) }),
      program({ framework: "soc2", renewalAt: iso(-3) }),
    ]);
    const result = await renderScreen();
    // The detail card renders the SELECTED framework's full name.
    expect(result.getByText("SOC 2 Type II")).toBeTruthy();
    expect(
      result.queryByText("ISO/IEC 27001 — Information Security Management"),
    ).toBeNull();
  });

  it("moves the detail when another framework is chosen", async () => {
    loadPrograms([
      program({ framework: "iso27001", renewalAt: iso(400) }),
      program({ framework: "soc2", renewalAt: iso(-3) }),
    ]);
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^Attested\. ISO 27001/));
    expect(
      result.getByText("ISO/IEC 27001 — Information Security Management"),
    ).toBeTruthy();
  });
});

describe("an empty response is an anomaly, not a clean bill", () => {
  it("says the server should always return a row per framework", async () => {
    loadPrograms([]);
    const result = await renderScreen();
    expect(result.getByText("No frameworks came back")).toBeTruthy();
    expect(
      result.getByText(/An empty list means something is wrong with the response/),
    ).toBeTruthy();
  });
});

describe("the writes stay on the desktop, and the screen says so", () => {
  it("offers no attest or revoke control anywhere", async () => {
    loadPrograms([program()]);
    const result = await renderScreen();
    expect(result.queryByText("Attest")).toBeNull();
    expect(result.queryByText("Revoke")).toBeNull();
    expect(
      result.getByText(/Attesting and withdrawing are done on the web admin/),
    ).toBeTruthy();
  });
});
