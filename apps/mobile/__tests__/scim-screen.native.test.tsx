/**
 * SCIM (app/(tabs)/scim.tsx) — the provisioning screen's state ladder.
 *
 * Nothing had ever mounted this screen. It is a governance surface whose only
 * write is irreversible (revoking a provisioning token immediately stops an
 * IdP creating or DEPROVISIONING accounts), and every one of its failure modes
 * is a sentence that is WRONG rather than a screen that is blank:
 *
 *   - "No provisioning tokens" rendered over a failed GET tells an admin their
 *     SSO provisioning was never set up. On the screen someone opens because
 *     they were told a bearer leaked, that is the most damaging string here:
 *     it ends the search for a token that is still live.
 *   - "0 active tokens" is the same lie in numeric form, which is exactly why
 *     ScimHeaderStrip renders an em-dash for an unmeasured counter. The screen
 *     has to pass `null` for it to be able to.
 *   - The offline case is NOT an error: neither query is offline-capable (a
 *     cached token list that omits a token minted five minutes ago is worse
 *     than no answer), so a closed gate must say "reconnect", not "none".
 *
 * `@/hooks/useScimOps` and `@/hooks/useOnlineQueryGate` resolve to the SAME
 * jest mock module (jest.routes.config.cjs), so one handle drives both the
 * gate and the per-hook query results — and the two lists can be given
 * DIFFERENT results, which a single blanket `useQuery` override could not do.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as ScimHooks from "@/hooks/useScimOps";

import Scim from "../app/(tabs)/scim";

const harness = ScimHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
};

/** A resolved query result. `isLoading` is false unless a test asks for it. */
function loaded(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    dataUpdatedAt: Date.now(),
    refetch: async () => ({ data }),
  };
}

function failed(error: unknown) {
  return {
    data: undefined,
    error,
    isError: true,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: false,
    dataUpdatedAt: 0,
    refetch: async () => ({ data: undefined }),
  };
}

function token(over: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    description: "Okta production",
    prefix: "scim_live_ab12",
    created_at: "2026-08-01T10:00:00.000Z",
    last_used_at: "2026-08-15T10:00:00.000Z",
    revoked_at: null,
    ...over,
  };
}

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

async function renderScim() {
  return render(<Scim />, { wrapper });
}

afterEach(() => {
  harness.__resetOnlineGateForTests();
  harness.__resetHookResultsForTests();
});

describe("SCIM screen state ladder", () => {
  it("never renders the empty copy — or a zero counter — for a FAILED token read", async () => {
    harness.__setHookResultForTests(
      "useMobileScimTokens",
      failed(new Error("upstream unavailable")),
    );
    harness.__setHookResultForTests("useMobileScimRoleMappings", loaded([]));
    await renderScim();

    // The screen is up.
    expect(screen.getByText("SCIM")).toBeTruthy();
    // …and it does NOT claim the workspace has no provisioning set up.
    expect(screen.queryByText("No provisioning tokens")).toBeNull();
    // The counter refuses to answer rather than answering "0" — the tile's
    // spoken label is the assertion, since the glyph alone is an em-dash.
    expect(screen.getByLabelText("Active tokens failed to load")).toBeTruthy();
    // And the failure is stated where the token cards would be, with a way
    // out — `errorPresentation` chooses the wording, so the assertion is that
    // an alert with a retry is what occupies the list, not the empty rung.
    expect(
      screen.getByText("Something went wrong loading this. Please try again."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Retry")).toBeTruthy();
  });

  it("says 'reconnect' rather than 'none' when the online gate is closed", async () => {
    harness.__setOnlineGateForTests({ enabled: false });
    // A disabled query never runs: not loading, not errored, no data. That is
    // the shape that used to fall through every ladder into the empty rung.
    harness.__setHookResultForTests(
      "useMobileScimTokens",
      loaded(undefined) as unknown,
    );
    harness.__setHookResultForTests(
      "useMobileScimRoleMappings",
      loaded(undefined) as unknown,
    );
    await renderScim();

    expect(screen.queryByText("No provisioning tokens")).toBeNull();
    expect(screen.getByLabelText("Active tokens failed to load")).toBeTruthy();
    expect(
      screen.getByText(
        "Reconnect to load SCIM tokens. Revoking a token is never queued for later — it has to reach the server now.",
      ),
    ).toBeTruthy();
  });

  it("does render the empty copy for a genuine empty SUCCESS", async () => {
    // The control. A guard that suppressed the empty rung unconditionally
    // would pass both tests above while deleting the first-run explanation an
    // admin needs to learn what a provisioning token even is.
    harness.__setHookResultForTests("useMobileScimTokens", loaded([]));
    harness.__setHookResultForTests("useMobileScimRoleMappings", loaded([]));
    await renderScim();

    expect(screen.getByText("No provisioning tokens")).toBeTruthy();
    expect(screen.getByText("No role mappings")).toBeTruthy();
    // An empty success IS an answer, so the counter speaks it.
    expect(screen.getByLabelText("0 Active tokens")).toBeTruthy();
  });

  it("renders loaded tokens and mappings, and counts only the live ones", async () => {
    harness.__setHookResultForTests(
      "useMobileScimTokens",
      loaded([
        token(),
        token({
          id: "tok-2",
          description: "Old Azure token",
          prefix: "scim_live_cd34",
          revoked_at: "2026-08-10T10:00:00.000Z",
        }),
      ]),
    );
    harness.__setHookResultForTests(
      "useMobileScimRoleMappings",
      loaded([
        { id: "m1", group_name: "Engineering", role: "editor", precedence: 10 },
      ]),
    );
    await renderScim();

    expect(screen.getByText("Okta production")).toBeTruthy();
    expect(screen.getByText("Engineering")).toBeTruthy();
    // One of the two tokens is revoked, so "active" is 1 — and the revoked one
    // is disclosed as a hint rather than silently folded into the total.
    expect(screen.getByLabelText("1 Active tokens, 1 revoked")).toBeTruthy();
    expect(screen.queryByText("No provisioning tokens")).toBeNull();
  });
});
