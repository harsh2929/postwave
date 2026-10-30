/**
 * PreferenceCenterThemeSection — the render contract (register: preference-
 * center theme customizer with live preview, Settings › Privacy).
 *
 * The policy is pinned in src/lib/preferenceCenterTheme.test.ts and the
 * transport in src/api/preferenceCenterTheme.test.ts; this file pins the card:
 *
 *  - the saved theme fills the fields, and the preview says in so many words
 *    that it is an approximation rather than the hosted page;
 *  - a save PATCHes the edited draft, adopts the server's answer as the new
 *    baseline, caches it and toasts;
 *  - a locally-refused value blocks the save and shows the SERVER'S OWN
 *    sentence plus the line saying it is the server's;
 *  - the contrast warning appears for the API's own default colour and does
 *    NOT block the save — the fact that makes it a warning and not a refusal;
 *  - a 422 renders the validator's sentence verbatim;
 *  - a release-held 503 renders the server's sentence with no Retry;
 *  - below admin, and under an API key, the card is omitted entirely;
 *  - the card is MOUNTED on the Settings screen for an admin.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";
import * as AuthStore from "@/store/auth";

const mockSaveCalls: unknown[] = [];
let mockSaveAnswer: { data: unknown; error: unknown } = { data: null, error: null };
jest.mock("@/api/preferenceCenterTheme", () => ({
  getPreferenceCenterTheme: jest.fn(async () => ({ data: null, error: null })),
  savePreferenceCenterTheme: async (theme: unknown) => {
    mockSaveCalls.push(theme);
    return mockSaveAnswer;
  },
}));

const mockToasts: { kind: string; message: string }[] = [];
jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: (entry: { kind: string; message: string }) => {
      mockToasts.push(entry);
    },
    dismiss: () => undefined,
  }),
}));

// eslint-disable-next-line import/first -- must follow the api/toast mocks.
import { PreferenceCenterThemeSection } from "@/components/settings/PreferenceCenterThemeSection";
// eslint-disable-next-line import/first
import Settings from "../app/(tabs)/settings";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  __getQueryClientForTests: () => { setQueryData: jest.Mock };
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

const refetch = jest.fn(async () => ({}));

function result(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isFetching: false,
    isSuccess: true,
    refetch,
    ...over,
  };
}

/** A saved theme exactly as lib/preferenceCenterTheme parses it. */
const THEME = {
  logoUrl: "https://cdn.example.com/logo.png",
  primaryColor: "#2563EB",
  footerText: "You subscribed at example.com.",
  showPostwaveBadge: true,
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

afterEach(() => {
  mockSaveCalls.length = 0;
  mockToasts.length = 0;
  mockSaveAnswer = { data: null, error: null };
  refetch.mockClear();
  queryHarness.__getQueryClientForTests().setQueryData.mockClear();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
});

describe("PreferenceCenterThemeSection", () => {
  it("fills the fields from the saved theme and labels the preview an approximation", async () => {
    queryHarness.__setQueryResultForTests(result({ data: THEME }));
    await render(<PreferenceCenterThemeSection />);
    expect(screen.getByText("Preference centre theme")).toBeTruthy();
    expect(screen.getByLabelText("Logo URL").props.value).toBe(THEME.logoUrl);
    expect(screen.getByLabelText("Primary colour").props.value).toBe("#2563EB");
    expect(screen.getByLabelText("Footer text").props.value).toBe(
      THEME.footerText,
    );
    expect(screen.getByText(/It is not a render of the hosted page/u)).toBeTruthy();
    // Nothing edited yet, so the save is unavailable rather than inviting.
    expect(
      screen.getByLabelText("Save preference centre theme").props
        .accessibilityState.disabled,
    ).toBe(true);
  });

  it("PATCHes the edited draft, adopts the server's answer and toasts", async () => {
    queryHarness.__setQueryResultForTests(result({ data: THEME }));
    const acknowledged = { ...THEME, footerText: "New footer." };
    mockSaveAnswer = { data: acknowledged, error: null };
    await render(<PreferenceCenterThemeSection />);
    await fireEvent.changeText(screen.getByLabelText("Footer text"), "New footer.");
    await fireEvent.press(screen.getByLabelText("Save preference centre theme"));
    await act(async () => {});
    expect(mockSaveCalls).toEqual([{ ...THEME, footerText: "New footer." }]);
    const client = queryHarness.__getQueryClientForTests();
    expect(client.setQueryData).toHaveBeenCalledTimes(1);
    expect(client.setQueryData.mock.calls[0]?.[1]).toEqual(acknowledged);
    expect(mockToasts).toEqual([
      {
        kind: "success",
        message: "Saved. The hosted preference centre uses this theme now.",
      },
    ]);
    // The acknowledged row is the new baseline: nothing is dirty any more.
    expect(
      screen.getByLabelText("Save preference centre theme").props
        .accessibilityState.disabled,
    ).toBe(true);
  });

  it("does not let a background refetch overwrite an edit in progress", async () => {
    queryHarness.__setQueryResultForTests(result({ data: THEME }));
    const view = await render(<PreferenceCenterThemeSection />);
    await fireEvent.changeText(screen.getByLabelText("Footer text"), "Half-typed");
    // A refetch lands with a DIFFERENT saved theme while the operator types.
    queryHarness.__setQueryResultForTests(
      result({ data: { ...THEME, footerText: "Someone else's footer" } }),
    );
    await view.rerender(<PreferenceCenterThemeSection />);
    expect(screen.getByLabelText("Footer text").props.value).toBe("Half-typed");
  });

  it("refuses a value the API refuses, in the API's words, without sending it", async () => {
    queryHarness.__setQueryResultForTests(result({ data: THEME }));
    await render(<PreferenceCenterThemeSection />);
    await fireEvent.changeText(
      screen.getByLabelText("Logo URL"),
      "http://localhost/logo.png",
    );
    expect(
      screen.getByText(
        "logo_url must be empty or an https URL without credentials",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The API's own sentence: it refuses this value with these exact words.",
      ),
    ).toBeTruthy();
    // The button itself goes unavailable — the refusal is not something the
    // operator has to discover by pressing Save and reading a toast.
    const save = screen.getByLabelText("Save preference centre theme");
    expect(save.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(save);
    await act(async () => {});
    expect(mockSaveCalls).toEqual([]);
    expect(mockToasts).toEqual([]);
  });

  it("never previews a logo URL the server would refuse", async () => {
    queryHarness.__setQueryResultForTests(result({ data: THEME }));
    await render(<PreferenceCenterThemeSection />);
    expect(
      screen.getByLabelText("Logo as the hosted page would load it"),
    ).toBeTruthy();
    await fireEvent.changeText(
      screen.getByLabelText("Logo URL"),
      "https://192.168.0.9/logo.png",
    );
    // No <Image> for a private host: the preview would fetch it from the phone.
    expect(
      screen.queryByLabelText("Logo as the hosted page would load it"),
    ).toBeNull();
    expect(
      screen.getByText(
        "This URL is not one the server accepts, so it is not previewed.",
      ),
    ).toBeTruthy();
  });

  it("warns about the API's own default colour but still allows the save", async () => {
    // #5B6CFF is 4.17:1 against white — under our floor, and what the server
    // hands back for a tenant that has never saved. Blocking would freeze them.
    const defaults = { ...THEME, primaryColor: "#5B6CFF" };
    queryHarness.__setQueryResultForTests(result({ data: defaults }));
    mockSaveAnswer = { data: { ...defaults, footerText: "x" }, error: null };
    await render(<PreferenceCenterThemeSection />);
    expect(screen.getByText(/4\.17:1 contrast/u)).toBeTruthy();
    expect(screen.getByText(/The API accepts it/u)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Footer text"), "x");
    await fireEvent.press(screen.getByLabelText("Save preference centre theme"));
    await act(async () => {});
    expect(mockSaveCalls).toHaveLength(1);
  });

  it("renders a 422's own sentence verbatim", async () => {
    queryHarness.__setQueryResultForTests(result({ data: THEME }));
    mockSaveAnswer = {
      data: null,
      error: {
        status: 422,
        code: "validation_failed",
        message: "footer_text must be at most 4096 bytes",
      },
    };
    await render(<PreferenceCenterThemeSection />);
    await fireEvent.changeText(screen.getByLabelText("Footer text"), "shorter");
    await fireEvent.press(screen.getByLabelText("Save preference centre theme"));
    await act(async () => {});
    expect(mockToasts).toEqual([
      { kind: "error", message: "footer_text must be at most 4096 bytes" },
    ]);
    expect(
      queryHarness.__getQueryClientForTests().setQueryData,
    ).not.toHaveBeenCalled();
  });

  it("renders a release-held 503 as the server's sentence with no Retry", async () => {
    queryHarness.__setQueryResultForTests(
      result({
        isError: true,
        isSuccess: false,
        error: Object.assign(new Error("Preference-centre theming is not enabled here."), {
          status: 503,
          capability: "privacy_portal",
          runtimeStatus: "unavailable",
          retryable: false,
        }),
      }),
    );
    await render(<PreferenceCenterThemeSection />);
    expect(
      screen.getByText("Preference-centre theming is not enabled here."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Retry")).toBeNull();
  });

  it("offers a Retry wired to THIS query for an ordinary failure", async () => {
    queryHarness.__setQueryResultForTests(
      result({
        isError: true,
        isSuccess: false,
        error: Object.assign(new Error("upstream down"), { status: 503 }),
      }),
    );
    await render(<PreferenceCenterThemeSection />);
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("is omitted entirely below admin, even with a theme cached", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    queryHarness.__setQueryResultForTests(result({ data: THEME }));
    await render(<PreferenceCenterThemeSection />);
    expect(screen.toJSON()).toBeNull();
  });

  it("is omitted under an API key (no session role to floor at admin)", async () => {
    authHarness.__setAuthStateForTests({ mode: "api_key" });
    queryHarness.__setQueryResultForTests(result({ data: THEME }));
    await render(<PreferenceCenterThemeSection />);
    expect(screen.toJSON()).toBeNull();
  });

  it("is MOUNTED on the Settings screen for an admin", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "admin", effectiveRole: "admin", tenantId: "t1" },
    });
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await render(<Settings />, { wrapper });
    expect(
      screen.getByLabelText("Loading the preference-centre theme"),
    ).toBeTruthy();
  });
});
