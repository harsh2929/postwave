/**
 * Voice tab render contract.
 *
 * The bug this pins (P1): with the online gate closed the profile query never
 * runs, so TanStack leaves data undefined with isLoading === false and
 * isError === false. The screen used to fall straight through into "No voice
 * profile yet" — a manufactured negative claim about tenant state made without
 * ever talking to the server, which invites the operator to rebuild a profile
 * that already exists. The gate notice must be checked BEFORE the data
 * ternary, and pull-to-refresh must respect the same gate.
 *
 * Also pinned: the six analytical sections the screen used to fetch and throw
 * away render when a profile IS present.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";

import Voice from "../app/(tabs)/voice";

const harness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
};

afterEach(() => {
  harness.__resetOnlineGateForTests();
  harness.__resetHookResultsForTests();
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

function profileQuery(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: jest.fn(async () => ({ data })),
  };
}

describe("voice tab", () => {
  it("never claims 'No voice profile yet' while the online gate is closed", async () => {
    harness.__setOnlineGateForTests({ enabled: false });
    harness.__setHookResultForTests("useVoiceProfile", profileQuery(undefined));

    await render(<Voice />, { wrapper });

    expect(screen.queryByText("No voice profile yet")).toBeNull();
    expect(
      screen.getByText("Reconnect to load your voice profile"),
    ).toBeTruthy();
    // The build affordance must not be offered either: we cannot reach the
    // server, and a disabled-looking button that silently no-ops is worse.
    expect(screen.queryByText("Build profile")).toBeNull();
  });

  it("offers a build action only once the gate is open and no profile exists", async () => {
    // POST /api/v1/voice/profile/build is write:campaigns, so the role is part
    // of the answer — see the viewer case below.
    harness.__setOnlineGateForTests({ effectiveRole: "editor" });
    harness.__setHookResultForTests(
      "useVoiceProfile",
      profileQuery({ profile: null, fromSnapshot: false }),
    );

    await render(<Voice />, { wrapper });

    expect(screen.getByText("No voice profile yet")).toBeTruthy();
    expect(screen.getByText("Build profile")).toBeTruthy();
  });

  it("does not offer Build profile to a viewer the build endpoint will 403", async () => {
    // `canBuild` was connectivity ALONE. POST /api/v1/voice/profile/build is
    // `write:campaigns` (hooks/useVoice header), so a viewer's only possible
    // outcome from that button was an error toast.
    harness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    harness.__setHookResultForTests(
      "useVoiceProfile",
      profileQuery({ profile: null, fromSnapshot: false }),
    );

    await render(<Voice />, { wrapper });

    // The screen still states the truth about tenant state…
    expect(screen.getByText("No voice profile yet")).toBeTruthy();
    // …it just does not offer the verb.
    expect(screen.queryByText("Build profile")).toBeNull();
  });

  it("lets an OWNER edit the authored brand voice", async () => {
    // PUT /api/v1/voice/brand-profile is `apikeys.ScopeAdmin`, which on the
    // session path admits owner|admin. The screen compared the role by string
    // equality against "admin", so the OWNER — the role the person who created
    // the workspace holds — was shown a read-only card the server would have
    // accepted a write from.
    harness.__setOnlineGateForTests({ effectiveRole: "owner" });
    harness.__setHookResultForTests(
      "useVoiceProfile",
      profileQuery({ profile: null, fromSnapshot: false }),
    );
    harness.__setHookResultForTests("useBrandVoiceProfile", {
      ...profileQuery({
        descriptors: ["warm"],
        writingRules: ["No exclamation marks."],
        sampleSnippets: [],
        empty: false,
      }),
      isLoading: false,
    });

    await render(<Voice />, { wrapper });

    expect(
      screen.getByLabelText("Edit the authored brand voice"),
    ).toBeTruthy();
  });

  it("withholds the authored-brand-voice edit from an editor", async () => {
    harness.__setOnlineGateForTests({ effectiveRole: "editor" });
    harness.__setHookResultForTests(
      "useVoiceProfile",
      profileQuery({ profile: null, fromSnapshot: false }),
    );
    harness.__setHookResultForTests("useBrandVoiceProfile", {
      ...profileQuery({
        descriptors: ["warm"],
        writingRules: [],
        sampleSnippets: [],
        empty: false,
      }),
      isLoading: false,
    });

    await render(<Voice />, { wrapper });

    expect(screen.queryByLabelText("Edit the authored brand voice")).toBeNull();
  });

  /**
   * An owner with an authored row that carries a snippet mobile cannot edit.
   * The save hook is left to the harness default on purpose in the first
   * case: it used to come back in the QUERY shape (pending forever), so Save
   * read "Saving…" and was disabled in every route test (TESTS-4).
   */
  function ownerWithAuthoredVoice() {
    harness.__setOnlineGateForTests({ effectiveRole: "owner" });
    harness.__setHookResultForTests(
      "useVoiceProfile",
      profileQuery({ profile: null, fromSnapshot: false }),
    );
    harness.__setHookResultForTests(
      "useBrandVoiceProfile",
      profileQuery({
        descriptors: ["warm"],
        writingRules: ["No exclamation marks."],
        sampleSnippets: ["keep me"],
        empty: false,
      }),
    );
  }

  it("opens the brand-voice editor with Save and Cancel pressable", async () => {
    ownerWithAuthoredVoice();

    await render(<Voice />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Edit the authored brand voice"));

    expect(screen.queryByLabelText("Saving…")).toBeNull();
    expect(
      screen.getByLabelText("Save").props.accessibilityState?.disabled,
    ).toBe(false);
    expect(
      screen.getByLabelText("Cancel").props.accessibilityState?.disabled,
    ).toBe(false);
  });

  it("saves the full replace, re-sending the snippets it cannot edit", async () => {
    ownerWithAuthoredVoice();
    const mutate = jest.fn();
    harness.__setHookResultForTests("useSaveBrandVoiceProfile", {
      isPending: false,
      mutate,
    });

    await render(<Voice />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Edit the authored brand voice"));
    await fireEvent.press(screen.getByLabelText("Save"));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      descriptors: ["warm"],
      writingRules: ["No exclamation marks."],
      sampleSnippets: ["keep me"],
    });
  });

  it("renders the measured sections the screen used to discard", async () => {
    // Rebuild is the same write:campaigns verb as Build, so the fixture needs
    // a role that may run it.
    harness.__setOnlineGateForTests({ effectiveRole: "editor" });
    harness.__setHookResultForTests(
      "useVoiceProfile",
      profileQuery({
        fromSnapshot: false,
        profile: {
          generated_at: "2026-07-10T10:00:00Z",
          version: 3,
          tonal: { humor: 0.7, optimism: 0.8, directness: 0.9, warmth: 0.9 },
          persona: { recurring_themes: ["shipping"] },
          stylistic: { avg_sentence_length: 12.5, passive_voice_pct: 0.1 },
          structural: { opening_hook_style: "question" },
          vocabulary: { distinctive_terms: [{ term: "throughput", score: 3 }] },
          representative_samples: [{ id: "s1", text: "We ship on Fridays." }],
          source_summary: { campaigns: { word_count: 900, item_count: 4 } },
        },
      }),
    );

    await render(<Voice />, { wrapper });

    expect(screen.getByText("Measured fingerprint")).toBeTruthy();
    expect(screen.getByText("How you write")).toBeTruthy();
    expect(screen.getByText("throughput")).toBeTruthy();
    expect(screen.getByText("We ship on Fridays.")).toBeTruthy();
    expect(screen.getByText("campaigns · 4 items · 900 words")).toBeTruthy();
    expect(screen.getByText("Rebuild profile")).toBeTruthy();
  });
});
