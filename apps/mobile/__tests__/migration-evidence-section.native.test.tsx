/**
 * PARITY (commerce-data) — migration verification evidence, field level.
 *
 * Four things a "does it render" assertion would never catch:
 *
 *   never on render — the evidence is a SECOND read of the verification route.
 *                     Mounting the section must not issue it; only the press
 *                     that opens the disclosure may.
 *   verbatim        — the source field name reaches the screen with its own
 *                     spacing, and the resource's status word is the server's
 *                     even when this build has never seen it.
 *   honest zero     — a resource the provider never exposed must not render as
 *                     "0 of 0", which reads as a clean pass.
 *   offline         — the read is never queued, so offline the section says so
 *                     instead of issuing a request that cannot land.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { MigrationEvidenceSection } from "../src/components/migrations/MigrationEvidenceSection";
import { parseMigrationEvidence } from "../src/lib/migrationEvidence";

const mockState = {
  enabledCalls: [] as boolean[],
  data: undefined as unknown,
  isError: false,
  error: null as unknown,
};

jest.mock("@/hooks/useMigrationEvidence", () => ({
  useMigrationVerificationEvidence: (_jobId: string | null, enabled: boolean) => {
    mockState.enabledCalls.push(enabled);
    return {
      data: enabled ? mockState.data : undefined,
      error: mockState.error,
      isError: mockState.isError,
      isLoading: false,
      isSuccess: !mockState.isError,
      refetch: jest.fn(),
    };
  },
}));

/** Shaped exactly like `canonical.VerificationReport`. */
const REPORT = {
  resource_completeness: [
    {
      resource: "automations",
      label: "Automations",
      source_total: 12,
      imported: 9,
      supported: true,
      status: "quarantined_by_a_future_build",
      notes: ["3 flows use a trigger with no Moosewave equivalent."],
    },
    {
      resource: "landing_pages",
      label: "Landing pages",
      source_total: 0,
      imported: 0,
      supported: false,
      status: "not_supported",
    },
  ],
  custom_fields_mapped: [
    { source: " Renewal Date ", canonical: "renewal_date", type: "date" },
  ],
  custom_fields_unmapped: ["Legacy Score"],
};

afterEach(() => {
  mockState.enabledCalls = [];
  mockState.data = undefined;
  mockState.isError = false;
  mockState.error = null;
});

async function renderSection(
  props: Partial<React.ComponentProps<typeof MigrationEvidenceSection>> = {},
) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <MigrationEvidenceSection
        jobId="job_1"
        status="completed"
        online
        {...props}
      />
    </SafeAreaProvider>,
  );
}

async function open() {
  await act(async () => {
    fireEvent.press(screen.getByText("Field-level evidence"));
  });
}

describe("MigrationEvidenceSection", () => {
  it("reads nothing until it is opened", async () => {
    mockState.data = parseMigrationEvidence(REPORT);
    await renderSection();

    expect(mockState.enabledCalls.every((enabled) => enabled === false)).toBe(
      true,
    );
    expect(screen.queryByText(/renewal_date/)).toBeNull();
  });

  it("shows the server's own before-and-after values once opened", async () => {
    mockState.data = parseMigrationEvidence(REPORT);
    await renderSection();
    await open();

    expect(mockState.enabledCalls).toContain(true);
    // Untrimmed on purpose: the spaces are part of the evidence.
    expect(screen.getByText(" Renewal Date  → renewal_date (date)")).toBeTruthy();
    // A status word this build has never seen still reaches the screen.
    expect(screen.getByText("quarantined_by_a_future_build")).toBeTruthy();
    expect(screen.getByText("9 of 12 · 3 short")).toBeTruthy();
    expect(
      screen.getByText("3 flows use a trigger with no Moosewave equivalent."),
    ).toBeTruthy();
    expect(screen.getByText("Legacy Score")).toBeTruthy();
  });

  it("never reads an unexposed resource as a clean zero", async () => {
    mockState.data = parseMigrationEvidence(REPORT);
    await renderSection();
    await open();

    expect(
      screen.getByText("The provider did not expose this resource."),
    ).toBeTruthy();
    expect(screen.queryByText("0 of 0")).toBeNull();
  });

  it("marks a still-running job's numbers provisional", async () => {
    mockState.data = parseMigrationEvidence(REPORT);
    await renderSection({ status: "running" });
    await open();

    expect(screen.getByText(/Provisional evidence/)).toBeTruthy();
    expect(screen.queryByText(/Final server report/)).toBeNull();
  });

  it("refuses to read offline rather than issuing a request that cannot land", async () => {
    mockState.data = parseMigrationEvidence(REPORT);
    await renderSection({ online: false });
    await open();

    expect(mockState.enabledCalls).not.toContain(true);
    expect(screen.getByText(/Reconnect to open it/)).toBeTruthy();
  });

  it("says a report without detail is not a claim that nothing moved", async () => {
    mockState.data = parseMigrationEvidence({});
    await renderSection();
    await open();

    expect(
      screen.getByText(/not a claim that nothing moved/),
    ).toBeTruthy();
  });
});
