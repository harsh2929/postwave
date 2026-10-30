/**
 * The selection's Validate verb — what only a rendered test can pin:
 *
 *  - the bar offers the fourth verb, ordered before the destructive one;
 *  - the results sheet leads with the honest receipt ("LOOK deliverable"),
 *    prints the surface-only clause, and lists ONLY the flagged rows.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { BulkValidationSheet } from "@/components/subscriber/BulkValidationSheet";
import { SubscriberSelectionBar } from "@/components/subscriber/SubscriberSelectionBar";
import { parseValidationBatch } from "@/lib/subscriberValidateEmails";
import type { ThemeTokens } from "@/lib/theme";

const t = new Proxy({}, { get: () => "#777777" }) as ThemeTokens;

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

describe("the selection bar's verbs", () => {
  it("offers Validate, before Unsubscribe", async () => {
    await render(
      <SubscriberSelectionBar
        count={3}
        loadedCount={10}
        allLoadedSelected={false}
        availability={{ enabled: true }}
        pending={false}
        onVerb={jest.fn()}
        onSelectAll={jest.fn()}
        onClear={jest.fn()}
        onDone={jest.fn()}
        t={t}
      />,
      { wrapper },
    );
    expect(screen.getByText("Validate")).toBeTruthy();
    expect(screen.getByText("Unsubscribe")).toBeTruthy();
  });
});

describe("the validation results sheet", () => {
  it("leads with the honest receipt, states surface-only, lists only flagged rows", async () => {
    const view = parseValidationBatch({
      results: [
        { email: "a@x.com", valid: true, verdict: "ok" },
        { email: "bad@", valid: false, verdict: "syntax_invalid" },
      ],
      summary: { total: 2, valid: 1, invalid: 1 },
    });
    await render(
      <BulkValidationSheet
        visible
        validation={{ view, skipped: 1 }}
        onClose={jest.fn()}
        t={t}
      />,
      { wrapper },
    );
    expect(
      screen.getByText(
        "1 of 2 look deliverable, 1 flagged. · 1 selected without an address",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Surface checks only/)).toBeTruthy();
    expect(screen.getByText("bad@")).toBeTruthy();
    expect(screen.getByText("Invalid syntax")).toBeTruthy();
    // The deliverable row is a count, not a listed row.
    expect(screen.queryByText("a@x.com")).toBeNull();
  });
});
