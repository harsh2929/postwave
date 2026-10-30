/**
 * What three inline Settings sections say AFTER an action (CQ-13).
 *
 * The Settings screen's contract (settings.tsx, Toast.tsx): a confirm BEFORE
 * a consequential action may be a modal; the outcome of an action is a toast.
 * PrivacyRetentionSection, ApiConnectionSection and
 * NotificationPreferencesSection answered every save, failure and validation
 * refusal with `Alert.alert` — a modal that costs a tap to dismiss after
 * something as routine as "Saved", on a screen where the sections around them
 * already speak in toasts. (WorkspaceSettingsSection, the fourth, is pinned in
 * workspace-date-format.native.test.tsx.)
 *
 * Each case renders under the REAL toast host and asserts the sentence the
 * user reads, the request that did (or did not) go out, and that an error
 * lands in the host's `alert` role — the role it gives errors and nothing
 * else. `Alert.alert` is spied and must never be reached.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactElement, ReactNode } from "react";
import { Alert, Share } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { PostwaveClient } from "@postwave/sdk";

import { ToastProvider } from "@/components/Toast";
import * as AuthStore from "@/store/auth";

type Answer = {
  data: unknown;
  error: { status: number; message: string } | null;
};

const mockRetention = {
  audit_log_retention_days: 365,
  email_event_retention_days: 730,
  unsubscribed_subscriber_retention_days: 365,
  updated_at: "2026-09-01T10:00:00Z",
};
const mockPrefs = {
  email_on_send_complete: true,
  email_on_approval_request: true,
  email_on_bounce_alert: false,
  digest_frequency: "daily",
};
const mockApi = {
  retentionCalls: [] as unknown[],
  retentionAnswer: null as Answer | null,
  prefsCalls: [] as unknown[],
  prefsAnswer: null as Answer | null,
};

jest.mock("@/api/settings", () => ({
  ...(jest.requireActual("@/api/settings") as Record<string, unknown>),
  getRetentionPolicy: async () => ({ data: { ...mockRetention }, error: null }),
  patchRetentionPolicy: async (patch: object) => {
    mockApi.retentionCalls.push(patch);
    return (
      mockApi.retentionAnswer ?? {
        data: { ...mockRetention, ...patch },
        error: null,
      }
    );
  },
  getNotificationPrefs: async () => ({ data: { ...mockPrefs }, error: null }),
  patchNotificationPrefs: async (patch: object) => {
    mockApi.prefsCalls.push(patch);
    return mockApi.prefsAnswer ?? { data: { ...mockPrefs, ...patch }, error: null };
  },
  sendTestNotification: async () => ({
    data: { sent: true, to: "ops@example.com" },
    error: null,
  }),
}));

// eslint-disable-next-line import/first -- must follow the api mock.
import { ApiConnectionSection } from "@/components/settings/ApiConnectionSection";
// eslint-disable-next-line import/first
import { NotificationPreferencesSection } from "@/components/settings/NotificationPreferencesSection";
// eslint-disable-next-line import/first
import { PrivacyRetentionSection } from "@/components/settings/PrivacyRetentionSection";

const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};
// The raw module, not a namespace import: babel's namespace interop copies a
// CommonJS module's exports, so a spy on the copy would never reach the
// section's own `validateApiBaseUrl` reference.
const configModule = jest.requireActual("@/lib/config") as {
  validateApiBaseUrl: (value: string) => unknown;
};
// The SDK stand-in answers any method it does not define with a resolving
// jest.fn. Defining `request` on the prototype is how a test makes the
// credential probe FAIL — the stand-in's `in` check honours the prototype.
const probePrototype = PostwaveClient.prototype as unknown as {
  request?: unknown;
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

type Host = ReturnType<typeof screen.getByText>;

/**
 * The role the toast host wraps `message` in: "alert" for an error and only
 * an error (Toast.tsx), "text" for any other kind. The host View is not an
 * accessibility element, so getByRole cannot reach it; walking up from the
 * words on screen can — and throws when they are not inside a toast at all.
 */
function toastRole(message: string): unknown {
  let node: Host | null = screen.getByText(message);
  while (node && node.props.accessibilityLiveRegion === undefined) {
    node = node.parent;
  }
  if (!node) throw new Error(`"${message}" is not inside a toast`);
  return node.props.accessibilityRole;
}

/** Mounted under the real toast host, as the Settings screen mounts it. */
async function mount(element: ReactElement) {
  const view = await render(<ToastProvider>{element}</ToastProvider>, {
    wrapper,
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

let alertSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
});
afterEach(() => {
  alertSpy.mockRestore();
  mockApi.retentionCalls = [];
  mockApi.retentionAnswer = null;
  mockApi.prefsCalls = [];
  mockApi.prefsAnswer = null;
  delete probePrototype.request;
  authHarness.__resetAuthStateForTests();
});

describe("PrivacyRetentionSection feedback", () => {
  const SAVE = "Save retention policy";

  it("confirms a saved retention policy with a toast", async () => {
    await mount(<PrivacyRetentionSection />);
    await fireEvent.changeText(screen.getByLabelText("Audit log (days)"), "90");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockApi.retentionCalls).toEqual([{ audit_log_retention_days: 90 }]);
    expect(toastRole("Retention policy updated.")).toBe("text");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range window in an error toast and sends nothing", async () => {
    await mount(<PrivacyRetentionSection />);
    await fireEvent.changeText(screen.getByLabelText("Audit log (days)"), "3");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockApi.retentionCalls).toEqual([]);
    expect(
      toastRole(
        "Audit logs must be 7-2555 days, email events 30-2555 days, and unsubscribed subscribers 7-3650 days.",
      ),
    ).toBe("alert");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("reports a refused save in an error toast and keeps the edit", async () => {
    mockApi.retentionAnswer = {
      data: null,
      error: { status: 500, message: "retention store unavailable" },
    };
    await mount(<PrivacyRetentionSection />);
    await fireEvent.changeText(
      screen.getByLabelText("Email events (days)"),
      "400",
    );
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockApi.retentionCalls).toEqual([{ email_event_retention_days: 400 }]);
    expect(
      toastRole("Couldn't save the retention policy. retention store unavailable"),
    ).toBe("alert");
    expect(screen.queryByText("Retention policy updated.")).toBeNull();
    expect(screen.getByLabelText("Email events (days)").props.value).toBe("400");
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe("NotificationPreferencesSection feedback", () => {
  it("rolls a refused toggle back and says so in an error toast", async () => {
    mockApi.prefsAnswer = {
      data: null,
      error: { status: 503, message: "preferences store unavailable" },
    };
    await mount(<NotificationPreferencesSection />);
    await fireEvent(screen.getByLabelText("Send complete"), "valueChange", false);
    await act(async () => {});
    expect(mockApi.prefsCalls).toEqual([{ email_on_send_complete: false }]);
    expect(
      toastRole(
        "Couldn't update notification preferences. preferences store unavailable",
      ),
    ).toBe("alert");
    expect(screen.getByLabelText("Send complete").props.value).toBe(true);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe("ApiConnectionSection feedback", () => {
  const SAVE = "Save API connection";
  const signIn = jest.fn(async (_draft: Record<string, string>) => undefined);

  beforeEach(() => {
    signIn.mockReset();
    signIn.mockResolvedValue(undefined);
    authHarness.__setAuthStateForTests({
      mode: "api_key",
      baseUrl: "https://api.moosewave.com",
      tenantId: "acme",
      apiKey: "pw_saved",
      signIn,
    });
  });

  it("confirms saved credentials with a toast", async () => {
    await mount(<ApiConnectionSection />);
    await fireEvent.changeText(screen.getByLabelText("API key"), "pw_rotated");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(signIn).toHaveBeenCalledWith({
      apiKey: "pw_rotated",
      baseUrl: "https://api.moosewave.com",
      tenantId: "acme",
    });
    expect(toastRole("API connection updated.")).toBe("text");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["API key", "Paste the workspace API key."],
    ["Tenant slug", "Enter the workspace slug."],
  ])(
    "refuses a blank %s in an error toast without signing in",
    async (field, sentence) => {
      await mount(<ApiConnectionSection />);
      await fireEvent.changeText(screen.getByLabelText(field), "");
      await fireEvent.press(screen.getByLabelText(SAVE));
      await act(async () => {});
      expect(toastRole(sentence)).toBe("alert");
      expect(signIn).not.toHaveBeenCalled();
      expect(alertSpy).not.toHaveBeenCalled();
    },
  );

  it("refuses an unusable API URL in an error toast without signing in", async () => {
    const validate = jest
      .spyOn(configModule, "validateApiBaseUrl")
      .mockReturnValue({
        ok: false,
        message: "API URL must not include credentials.",
      });
    try {
      await mount(<ApiConnectionSection />);
      await fireEvent.press(screen.getByLabelText(SAVE));
      await act(async () => {});
      expect(toastRole("API URL must not include credentials.")).toBe("alert");
      expect(signIn).not.toHaveBeenCalled();
      expect(alertSpy).not.toHaveBeenCalled();
    } finally {
      validate.mockRestore();
    }
  });

  it("reports credentials the gateway rejects in an error toast, saving nothing", async () => {
    probePrototype.request = async () => {
      throw new Error("401 invalid api key");
    };
    await mount(<ApiConnectionSection />);
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    // The auth-error redactor stands in with a fixed sentence in this suite.
    expect(
      toastRole("Couldn't verify credentials. Authentication failed"),
    ).toBe("alert");
    expect(signIn).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("reports credentials that verified but could not be stored in an error toast", async () => {
    signIn.mockRejectedValue(new Error("keychain locked"));
    await mount(<ApiConnectionSection />);
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(
      toastRole("Couldn't save the API connection. Authentication failed"),
    ).toBe("alert");
    expect(screen.queryByText("API connection updated.")).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("reports a share sheet that failed to open in an error toast", async () => {
    authHarness.__resetAuthStateForTests();
    const share = jest
      .spyOn(Share, "share")
      .mockRejectedValue(new Error("no share target"));
    try {
      await mount(<ApiConnectionSection />);
      await fireEvent.press(screen.getByLabelText("Share connection details"));
      await act(async () => {});
      expect(share).toHaveBeenCalledTimes(1);
      expect(
        toastRole("Couldn't share the connection details. no share target"),
      ).toBe("alert");
      expect(alertSpy).not.toHaveBeenCalled();
    } finally {
      share.mockRestore();
    }
  });
});
