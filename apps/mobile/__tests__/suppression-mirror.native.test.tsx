/**
 * The ESP mirror at the rendered seam.
 *
 * The vitest suites prove the transport folds the 503 not-configured reply
 * into the data channel; what they cannot prove is that the SHEET tells those
 * outcomes apart — a setup pointer is information, a failed run is an error —
 * and that the header offers the verb only where the write can actually run
 * (admin, email channel, online). Remove the Sync wire from
 * SuppressionHeaderActions and the first test goes red.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { MirrorFromEspSheet } from "../src/components/deliverability/MirrorFromEspSheet";
import { SuppressionHeaderActions } from "../src/components/deliverability/SuppressionHeaderActions";
import type { MirrorOutcome } from "../src/lib/suppressionMirror";

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useSuppressionWrites", () =>
  require("./mocks/queryHooks.cjs"),
);

function mirrorMutation(outcome?: MirrorOutcome, error?: Error) {
  return {
    isPending: false,
    reset: jest.fn(),
    mutate: jest.fn(
      (
        _provider: string,
        callbacks?: {
          onSuccess?: (outcome: MirrorOutcome) => void;
          onError?: (err: Error) => void;
        },
      ) => {
        if (error) callbacks?.onError?.(error);
        else if (outcome) callbacks?.onSuccess?.(outcome);
      },
    ),
  };
}

async function renderWithin(element: React.ReactElement) {
  return render(element, {
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
  });
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
});

const noop = () => undefined;

function headerActions(over: Partial<Parameters<typeof SuppressionHeaderActions>[0]> = {}) {
  return (
    <SuppressionHeaderActions
      channel="email"
      canWrite
      rowCount={5}
      total={5}
      online
      selecting={false}
      exporting={false}
      onSelect={noop}
      onExport={noop}
      onAdd={noop}
      onMirror={noop}
      {...over}
    />
  );
}

describe("the header offers Sync only where the mirror can run", () => {
  it("offers it to an admin on the email channel while online", async () => {
    const screen = await renderWithin(headerActions());
    expect(
      screen.getByLabelText("Mirror suppressions from your sending provider"),
    ).toBeTruthy();
  });

  it("hides it on the push channel — the mirror writes the EMAIL table", async () => {
    const screen = await renderWithin(headerActions({ channel: "push" }));
    expect(
      screen.queryByLabelText("Mirror suppressions from your sending provider"),
    ).toBeNull();
  });

  it("hides it offline instead of offering a button that can only refuse", async () => {
    const screen = await renderWithin(headerActions({ online: false }));
    expect(
      screen.queryByLabelText("Mirror suppressions from your sending provider"),
    ).toBeNull();
  });

  it("hides it from a role the ScopeAdmin mount would 403", async () => {
    const screen = await renderWithin(headerActions({ canWrite: false }));
    expect(
      screen.queryByLabelText("Mirror suppressions from your sending provider"),
    ).toBeNull();
  });
});

describe("MirrorFromEspSheet outcomes", () => {
  it("runs the selected provider and shows the import summary", async () => {
    const mutation = mirrorMutation({
      kind: "imported",
      result: { provider: "mailchimp", fetched: 10, imported: 3, skipped: 7, errors: 0 },
    });
    queryHooks.__setHookResultForTests("useMirrorSuppressions", mutation);
    const screen = await renderWithin(
      <MirrorFromEspSheet visible onClose={noop} />,
    );
    fireEvent.press(
      screen.getByLabelText("Mirror suppressions from Mailchimp"),
    );
    await waitFor(() =>
      expect(mutation.mutate).toHaveBeenCalledWith(
        "mailchimp",
        expect.anything(),
      ),
    );
    expect(
      screen.getByText("Checked 10 provider rows — 3 imported, 7 already present."),
    ).toBeTruthy();
  });

  it("renders an unconfigured provider as a setup pointer, not a failure", async () => {
    queryHooks.__setHookResultForTests(
      "useMirrorSuppressions",
      mirrorMutation({ kind: "not_configured", reason: "The mailchimp mirror has no API key." }),
    );
    const screen = await renderWithin(
      <MirrorFromEspSheet visible onClose={noop} />,
    );
    fireEvent.press(
      screen.getByLabelText("Mirror suppressions from Mailchimp"),
    );
    expect(
      await screen.findByText("The mailchimp mirror has no API key."),
    ).toBeTruthy();
  });

  it("renders a genuine failure's own sentence (a 403 reads as a permission rule)", async () => {
    queryHooks.__setHookResultForTests(
      "useMirrorSuppressions",
      mirrorMutation(
        undefined,
        new Error("Mirroring suppressions is restricted to workspace owners and admins."),
      ),
    );
    const screen = await renderWithin(
      <MirrorFromEspSheet visible onClose={noop} />,
    );
    fireEvent.press(
      screen.getByLabelText("Mirror suppressions from Mailchimp"),
    );
    expect(
      await screen.findByText(
        "Mirroring suppressions is restricted to workspace owners and admins.",
      ),
    ).toBeTruthy();
  });
});
