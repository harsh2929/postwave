/**
 * A migration job card must survive a job whose fields are absent.
 *
 * WHAT HAPPENED. Walking the app on 2026-08-19, the migrations screen
 * RED-SCREENED: "Render Error — Cannot read property 'slice' of undefined",
 * from `job.id.slice(-6)` in an accessibilityLabel.
 *
 * The cause was upstream and entirely plausible in production:
 * `GET /api/v1/migrations` answered **200 with text/html** — an SPA fallback
 * served because the migrations upstream was absent — so the client parsed a
 * document into job-shaped nothing and every field was undefined.
 *
 * A screen may show a job it cannot fully describe. It may not take the whole
 * app down because an identifier is missing, and it must not do so from an
 * ACCESSIBILITY LABEL, which is a string a sighted user never even reads.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { MigrationJobCard } from "@/components/migrations/MigrationJobCard";

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

function props(job: Record<string, unknown>) {
  return {
    job: job as never,
    statusTone: (() => "neutral") as never,
    imported: "0",
    rollbackText: null as never,
    busy: false,
    canAct: true,
    onCancel: jest.fn(),
    onShareId: jest.fn(),
    onOpenReport: jest.fn(),
  };
}

describe("MigrationJobCard on a malformed job", () => {
  it("renders a job with NO id rather than crashing", async () => {
    // The exact payload the SPA-fallback produced.
    await expect(
      (async () =>
        render(<MigrationJobCard {...props({ status: "running" })} />, {
          wrapper,
        }))(),
    ).resolves.toBeTruthy();
  });

  it.each([
    ["a numeric id", { id: 12345, status: "running" }],
    ["a null id", { id: null, status: "running" }],
    ["an object id", { id: { v: 1 }, status: "running" }],
    ["an empty job", {}],
  ])("survives %s", async (_label, job) => {
    await expect(
      (async () => render(<MigrationJobCard {...props(job)} />, { wrapper }))(),
    ).resolves.toBeTruthy();
  });
});
