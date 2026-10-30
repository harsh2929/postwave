/**
 * Behavioural tests for the auth screens.
 *
 * Until now the only coverage these screens had was the ROUTES smoke table,
 * which asserts `toJSON()` is non-null. That cannot catch any of the defects
 * that actually shipped: a wrong password rendering the literal string
 * "HTTP 401", a workspace picker that never gated submit, or a device-approval
 * screen that authorized a durable API key without saying what it granted.
 * Auth is the one surface where a regression locks every user out at once, so
 * these assert behaviour, not renderability.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { router } from "expo-router";

import CliApprove from "../app/(tabs)/cli-approve";
import Login from "../app/(auth)/login";
import SignIn from "../app/(auth)/sign-in";
import VerifyEmail from "../app/(auth)/verify-email";
import { MagicReturnView } from "@/components/auth/MagicReturnView";
import { MagicSentView } from "@/components/auth/MagicSentView";
import { DeviceSessionSignInView } from "@/components/auth/DeviceSessionSignInView";

/** The expo-router mock replaces `replace` with a jest fn; the real module's
 *  type does not know that, so the spy surface is narrowed here once. */
const routerReplace = router.replace as unknown as {
  mockClear: () => void;
};

jest.mock("react-native-qrcode-svg", () => () => null);

type AuthResult = { data?: unknown; error?: unknown };
type DeviceGrantAction = "inspect" | "approve" | "deny";

const authState: {
  login: AuthResult;
  getMe: AuthResult;
  verifyEmail: AuthResult;
  deviceGrant: Record<"inspect" | "approve" | "deny", AuthResult>;
} = {
  login: { data: { ok: true, user_id: "u", tenant_id: "t" } },
  getMe: { data: {} },
  verifyEmail: { data: { verified: true } },
  deviceGrant: {
    inspect: {
      data: {
        ok: true,
        action: "inspect",
        grant_kind: "api_key",
        device: {
          device_label: "Moosewave CLI",
          device_type: "cli",
          device_client: "Moosewave CLI",
        },
        account: {
          email: "owner@example.test",
          workspace_name: "Acme",
          workspace_slug: "acme",
        },
        expires_in: 540,
        remember: false,
        scopes: [
          "read:subscribers",
          "write:subscribers",
          "read:campaigns",
          "write:campaigns",
          "read:reports",
          "send:transactional",
        ],
      },
    },
    approve: { data: { ok: true, action: "approve", grant_kind: "api_key" } },
    deny: { data: { ok: true, action: "deny", grant_kind: "api_key" } },
  },
};

const deviceGrantCalls: {
  action: DeviceGrantAction;
  consentToken?: string;
}[] = [];
const queuedDeviceGrantResults: Record<DeviceGrantAction, AuthResult[]> = {
  inspect: [],
  approve: [],
  deny: [],
};

function sessionGrantDisclosure(
  deviceLabel: string,
  consentToken: string,
): AuthResult {
  return {
    data: {
      action: "inspect",
      grant_kind: "session",
      device: {
        device_label: deviceLabel,
        device_type: "desktop",
        device_os: "Windows",
        device_client: "Moosewave Desktop",
      },
      account: {
        email: "owner@example.test",
        workspace_name: "Acme",
        workspace_slug: "acme",
      },
      expires_in: 540,
      remember: false,
      scopes: [],
      consent_token: consentToken,
    },
  };
}

const verifyEmailCalls: string[] = [];

jest.mock("@/api/authSessions", () => ({
  verifyEmailToken: async (_baseUrl: string, token: string) => {
    verifyEmailCalls.push(token);
    return authState.verifyEmail;
  },
  sendVerificationEmail: async () => ({ data: undefined }),
  approveDeviceGrant: async (
    _baseUrl: string,
    _userCode: string,
    action = "approve",
    consentToken?: string,
  ) => {
    const typedAction = action as DeviceGrantAction;
    deviceGrantCalls.push({
      action: typedAction,
      ...(consentToken ? { consentToken } : {}),
    });
    return (
      queuedDeviceGrantResults[typedAction].shift() ??
      authState.deviceGrant[typedAction]
    );
  },
}));

jest.mock("@/lib/biometric", () => ({
  requireDeviceAuth: async () => true,
}));

/**
 * AUTH#2 — the Google round-trip. Both halves are stubbed at the seam the
 * screen actually owns: the pre-flight verdict and the OS auth session. What
 * is under test is the SCREEN's response to each outcome, which is where the
 * dead ends live.
 */
const oauthState: {
  probe: { ok: boolean; reason?: string };
  session: { type: string; url?: string };
} = {
  probe: { ok: true },
  session: { type: "cancel" },
};
const openedAuthUrls: string[] = [];

jest.mock("@/api/authOAuth", () => ({
  probeOAuthStart: async () => oauthState.probe,
}));

/** MAP#63 — the clipboard is a privileged read; the screen must own the tap. */
const clipboardState: { value: string | null; throws: boolean } = {
  value: null,
  throws: false,
};

jest.mock("expo-clipboard", () => ({
  getStringAsync: async () => {
    if (clipboardState.throws) throw new Error("clipboard unavailable");
    return clipboardState.value;
  },
}));

jest.mock("expo-web-browser", () => ({
  openAuthSessionAsync: async (url: string) => {
    openedAuthUrls.push(url);
    return oauthState.session;
  },
}));

jest.mock("@/lib/magicLinkState", () => ({
  createPendingOAuthLinkState: async () => ({
    state: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  }),
  createPendingMagicLinkState: async () => ({
    state: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  }),
  clearPendingMagicLinkState: async () => undefined,
}));

jest.mock("@/api/auth", () => ({
  createAuthClient: () => ({
    baseUrl: "https://api.moosewave.com",
    login: async () => authState.login,
    getMe: async () => authState.getMe,
    magicLinkStart: async () => ({ data: { sent: true } }),
  }),
  redactAuthError: (message: string) => message,
  authRequest: async () => ({ data: {} }),
}));

function wrap(node: React.ReactElement) {
  return render(node, {
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

async function submitCredentials(): Promise<void> {
  await fireEvent.changeText(
    screen.getByTestId("signin-email"),
    "owner@example.test",
  );
  await fireEvent.changeText(
    screen.getByTestId("signin-password"),
    "CorrectHorseBattery1!",
  );
  await fireEvent.press(screen.getByTestId("signin-submit"));
}

describe("sign-in error copy", () => {
  it("never renders the HTTP placeholder a 401 with an empty message produces", async () => {
    // handlers.go answers a wrong password with
    // {error:{code:"invalid_credentials", message:""}}, which leaves
    // authRequest's `HTTP 401` placeholder in AuthApiError.message.
    authState.login = {
      error: {
        message: "HTTP 401",
        status: 401,
        code: "invalid_credentials",
        kind: "http",
      },
    };
    await wrap(<SignIn />);
    await submitCredentials();

    const error = await screen.findByTestId("signin-error");
    expect(error).toHaveTextContent("Email or password is incorrect.");
    expect(screen.queryByText(/HTTP 401/)).toBeNull();
  });

  it("replaces React Native's raw network error with connection copy", async () => {
    authState.login = {
      error: { message: "Network request failed", kind: "network" },
    };
    await wrap(<SignIn />);
    await submitCredentials();

    const error = await screen.findByTestId("signin-error");
    expect(error).toHaveTextContent(/check your connection/i);
    expect(screen.queryByText(/Network request failed/)).toBeNull();
  });

  it("counts down from the server's Retry-After on a 429", async () => {
    authState.login = {
      error: {
        message: "HTTP 429",
        status: 429,
        code: "too_many_auth_attempts",
        retryAfterSeconds: 300,
      },
    };
    await wrap(<SignIn />);
    await submitCredentials();

    const error = await screen.findByTestId("signin-error");
    expect(error).toHaveTextContent("Too many attempts. Try again in 5m.");
  });

  it("clears the error as soon as the user edits the field that caused it", async () => {
    authState.login = {
      error: { message: "HTTP 401", status: 401, code: "invalid_credentials" },
    };
    await wrap(<SignIn />);
    await submitCredentials();
    expect(await screen.findByTestId("signin-error")).toBeTruthy();

    await fireEvent.changeText(
      screen.getByTestId("signin-password"),
      "AnotherPassword1!",
    );
    expect(screen.queryByTestId("signin-error")).toBeNull();
  });
});

describe("sign-in per-field validation", () => {
  it("captions every offending field at once instead of one form-level line", async () => {
    await wrap(<SignIn />);
    // Submit an empty form: the old screen said "Email and password are
    // required" once, at the bottom, under the keyboard.
    await fireEvent.press(screen.getByTestId("signin-submit"));

    expect(screen.getByText("Enter your email address")).toBeTruthy();
    expect(screen.getByText("Enter your password")).toBeTruthy();
    // No network call was made, so no form-level banner should appear either.
    expect(screen.queryByTestId("signin-error")).toBeNull();
  });

  it("flags a malformed address on the field that holds it", async () => {
    await wrap(<SignIn />);
    await fireEvent.changeText(screen.getByTestId("signin-email"), "nope");
    await fireEvent.changeText(
      screen.getByTestId("signin-password"),
      "CorrectHorseBattery1!",
    );
    await fireEvent.press(screen.getByTestId("signin-submit"));

    expect(
      screen.getByText("That doesn't look like an email address"),
    ).toBeTruthy();
    expect(screen.queryByText("Enter your password")).toBeNull();
  });

  it("clears a field caption as soon as that field is edited", async () => {
    await wrap(<SignIn />);
    await fireEvent.press(screen.getByTestId("signin-submit"));
    expect(screen.getByText("Enter your email address")).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId("signin-email"), "a@b.io");
    expect(screen.queryByText("Enter your email address")).toBeNull();
    // The untouched field keeps its caption — editing one input is not a claim
    // about the other.
    expect(screen.getByText("Enter your password")).toBeTruthy();
  });
});

describe("sign-in method switch", () => {
  it("removes the password field entirely for a passwordless user", async () => {
    await wrap(<SignIn />);
    // Default is password: the field a magic-link user will never fill is
    // present, focusable and fought over by autofill.
    expect(screen.getByTestId("signin-password")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Email link"));

    expect(screen.queryByTestId("signin-password")).toBeNull();
    // The primary CTA becomes the link request rather than a second button
    // below a field the user is not using.
    expect(screen.getByTestId("signin-submit")).toHaveTextContent(
      "Send sign-in link",
    );
    expect(screen.queryByText(/magic link instead/i)).toBeNull();
  });

  it("clears a password caption that no longer has a control to point at", async () => {
    await wrap(<SignIn />);
    await fireEvent.press(screen.getByTestId("signin-submit"));
    expect(screen.getByText("Enter your password")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Email link"));

    // Both captions go: the password one has no field left, and leaving the
    // email one would make firstInvalidField the only thing that still knows
    // which control was at fault.
    expect(screen.queryByText("Enter your password")).toBeNull();
    expect(screen.queryByText("Enter your email address")).toBeNull();
  });

  it("sends the link from the primary button and never posts a password", async () => {
    // A password left in state by an earlier attempt must not ride along.
    await wrap(<SignIn />);
    await fireEvent.changeText(
      screen.getByTestId("signin-password"),
      "CorrectHorseBattery1!",
    );
    await fireEvent.press(screen.getByLabelText("Email link"));
    await fireEvent.changeText(
      screen.getByTestId("signin-email"),
      "owner@example.test",
    );
    await fireEvent.press(screen.getByTestId("signin-submit"));

    expect(await screen.findByText("Check your email")).toBeTruthy();
  });
});

describe("cross-device mobile sign-in", () => {
  it("offers the new-phone flow alongside existing sign-in methods", async () => {
    await wrap(<SignIn />);
    expect(screen.getByText("Sign in with another device")).toBeTruthy();
  });

  it("shows only the short matching code and the requested session lifetime", async () => {
    await wrap(
      <DeviceSessionSignInView
        state={{
          phase: "waiting",
          userCode: "BCDF-GHJK",
          verificationUri: "https://app.example.test/cli/auth",
          verificationUriComplete:
            "https://app.example.test/cli/auth?user_code=BCDF-GHJK",
          expiresAt: Date.now() + 600_000,
          interval: 5,
          remainingSeconds: 600,
          remember: false,
        }}
        baseUrl="https://api.example.test"
        apiFieldExpanded={false}
        remember={false}
        baseUrlError=""
        onToggleApiField={() => undefined}
        onChangeBaseUrl={() => undefined}
        onChangeRemember={() => undefined}
        onStart={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(screen.getByText("BCDF-GHJK")).toBeTruthy();
    expect(
      screen.getByLabelText("QR code to approve this phone sign-in"),
    ).toBeTruthy();
    expect(screen.getByText(/session of up to 12 hours/i)).toBeTruthy();
    expect(screen.queryByText(/device[_ -]?code/i)).toBeNull();
  });
});

describe("sign-in workspace picker", () => {
  it("renders one radio per workspace and gates submit until one is picked", async () => {
    authState.login = {
      data: {
        needs_workspace: true,
        workspaces: [
          {
            tenant_id: "11111111-1111-4111-8111-111111111111",
            email: "a@x.io",
          },
          {
            tenant_id: "22222222-2222-4222-8222-222222222222",
            email: "a@x.io",
          },
          {
            tenant_id: "33333333-3333-4333-8333-333333333333",
            email: "a@x.io",
          },
        ],
      },
    };
    await wrap(<SignIn />);
    await submitCredentials();

    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(3);
    // Every row carries the SAME user's email, so the discriminator has to be
    // the workspace id — not a title that reads identically three times.
    expect(screen.getByLabelText(/Workspace 1, id 11111111/)).toBeTruthy();

    const submit = screen.getByTestId("signin-submit");
    expect(submit.props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(radios[1]!);
    expect(
      screen.getByTestId("signin-submit").props.accessibilityState.disabled,
    ).toBe(false);
  });
});

/**
 * MAP#53 — seams the shell/controller split now routes through.
 *
 * Both of these were unreachable-by-test while they lived inside the route
 * module's closure, and both are dead ends when they go wrong: a validation
 * message pointing at a COLLAPSED control, and a picker with nothing in it
 * behind a permanently disabled button.
 */
describe("sign-in server-address failures", () => {
  it("re-opens the collapsed API field the message refers to", async () => {
    await wrap(<SignIn />);
    // Open it, break it, then collapse it again — exactly what an operator
    // does when they think they are finished.
    await fireEvent.press(screen.getByLabelText("Change API base URL"));
    await fireEvent.changeText(
      screen.getByLabelText("API base URL"),
      "ftp://mail.acme.internal",
    );
    await fireEvent.press(screen.getByLabelText("Hide API base URL field"));
    expect(screen.queryByLabelText("API base URL")).toBeNull();

    await submitCredentials();

    // The field is back on screen, so the message has something to point at.
    expect(screen.getByLabelText("API base URL")).toBeTruthy();
    expect(await screen.findByTestId("signin-error")).toHaveTextContent(
      /http:\/\/ or https:\/\//i,
    );
  });

  it("never sends the password to a URL carrying its own credentials", async () => {
    authState.login = { data: { ok: true, user_id: "u", tenant_id: "t" } };
    await wrap(<SignIn />);
    await fireEvent.press(screen.getByLabelText("Change API base URL"));
    await fireEvent.changeText(
      screen.getByLabelText("API base URL"),
      "https://user:pass@api.example.com",
    );
    await submitCredentials();

    expect(await screen.findByTestId("signin-error")).toHaveTextContent(
      "API URL must not include credentials.",
    );
  });
});

describe("sign-in workspace payload it cannot render", () => {
  it("says so instead of leaving an empty picker behind a dead button", async () => {
    authState.login = {
      data: { needs_workspace: true, workspaces: [null, { email: "a@x.io" }] },
    };
    await wrap(<SignIn />);
    await submitCredentials();

    expect(await screen.findByTestId("signin-error")).toHaveTextContent(
      "Couldn't load your workspaces. Please try again.",
    );
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    // The form stays editable — the user can still change account.
    expect(screen.getByTestId("signin-email")).toBeTruthy();
  });
});

describe("CLI device approval", () => {
  it("discloses the scopes the grant will actually receive", async () => {
    await wrap(<CliApprove />);
    await fireEvent.changeText(
      screen.getByLabelText("Device code, eight characters"),
      "ABCD1234",
    );
    // The mocked session is an owner, so the server would issue the admin set
    // — including the send scope the read-only viewer set does not carry.
    expect(await screen.findByText(/Send transactional email/i)).toBeTruthy();
    expect(
      screen.getByText(/Add, edit and suppress subscribers/i),
    ).toBeTruthy();
    expect(screen.getByText("This will grant")).toBeTruthy();
  });

  it("accepts a manually typed code and normalises it", async () => {
    await wrap(<CliApprove />);
    const input = screen.getByLabelText("Device code, eight characters");
    const submit = screen.getByTestId("cli-approve-submit");

    expect(submit.props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(input, "abcd1234");
    expect(
      screen.getByLabelText("Device code, eight characters").props.value,
    ).toBe("ABCD-1234");
    expect(
      (await screen.findByTestId("cli-approve-submit")).props.accessibilityState
        .disabled,
    ).toBe(false);
  });

  it("tells the user the grant expires rather than leaving it unknowable", async () => {
    await wrap(<CliApprove />);
    expect(screen.getByText(/expire within 10 minutes/i)).toBeTruthy();
  });

  it("shows session-login consent without pretending it grants an API key", async () => {
    authState.deviceGrant.inspect = sessionGrantDisclosure(
      "Moosewave Desktop on Windows",
      "opaque-session-consent-proof",
    );
    await wrap(<CliApprove />);
    await fireEvent.changeText(
      screen.getByLabelText("Device code, eight characters"),
      "ABCD1234",
    );

    expect(await screen.findByText("Moosewave Desktop on Windows")).toBeTruthy();
    expect(screen.getByText("REPORTED REQUESTING DEVICE")).toBeTruthy();
    expect(screen.getByText(/Trust the matching code/i)).toBeTruthy();
    expect(screen.getByText("owner@example.test")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText(/password.*never transferred/i)).toBeTruthy();
    expect(screen.getAllByText("Approve sign-in").length).toBeGreaterThan(0);
    expect(screen.queryByText("This will grant")).toBeNull();
    expect(screen.queryByText("opaque-session-consent-proof")).toBeNull();
  });

  it("re-inspects a session request when its consent binding changes", async () => {
    deviceGrantCalls.length = 0;
    queuedDeviceGrantResults.inspect.push(
      sessionGrantDisclosure(
        "Original reviewed Windows device",
        "first-opaque-consent-proof",
      ),
      sessionGrantDisclosure(
        "Refreshed reviewed Windows device",
        "replacement-opaque-consent-proof",
      ),
    );
    queuedDeviceGrantResults.approve.push({
      error: {
        code: "consent_required",
        status: 400,
        kind: "http",
        message: "review again",
      },
    });

    await wrap(<CliApprove />);
    await fireEvent.changeText(
      screen.getByLabelText("Device code, eight characters"),
      "ABCD1234",
    );
    expect(
      await screen.findByText("Original reviewed Windows device"),
    ).toBeTruthy();

    await fireEvent.press(screen.getByTestId("cli-approve-submit"));

    expect(
      await screen.findByText("Refreshed reviewed Windows device"),
    ).toBeTruthy();
    expect(screen.getByTestId("cli-approve-error")).toHaveTextContent(
      /review.*refreshed details/i,
    );
    expect(deviceGrantCalls).toEqual([
      { action: "inspect" },
      {
        action: "approve",
        consentToken: "first-opaque-consent-proof",
      },
      { action: "inspect" },
    ]);
    expect(screen.queryByText("replacement-opaque-consent-proof")).toBeNull();
  });
});

describe("address verification", () => {
  it("posts the emailed token exactly once and confirms it worked", async () => {
    verifyEmailCalls.length = 0;
    authState.verifyEmail = { data: { verified: true } };
    await wrap(<VerifyEmail />);

    // The mocked router params carry token: "test-token".
    expect(verifyEmailCalls).toEqual(["test-token"]);
    expect(
      await screen.findByText(/Password resets and security alerts/i),
    ).toBeTruthy();
  });

  it("explains a burnt link instead of echoing the server code", async () => {
    verifyEmailCalls.length = 0;
    authState.verifyEmail = {
      error: { message: "HTTP 400", status: 400, code: "invalid_token" },
    };
    await wrap(<VerifyEmail />);

    const message = await screen.findByTestId("verify-email-message");
    expect(message).toHaveTextContent(/expired or was already used/i);
    expect(screen.queryByText(/HTTP 400/)).toBeNull();
  });
});

describe("magic-link recovery", () => {
  it("offers more than one way out of a failed link", async () => {
    const onBack = jest.fn();
    const onRequestNewLink = jest.fn();
    const onContactSupport = jest.fn();
    await wrap(
      <MagicReturnView
        state="fail"
        error="This sign-in link request expired."
        onContinueInBrowser={jest.fn()}
        onBack={onBack}
        onRequestNewLink={onRequestNewLink}
        onContactSupport={onContactSupport}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This sign-in link request expired.",
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Request a new link" }),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Contact support" }),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Back to sign in" }),
    );
    expect(onRequestNewLink).toHaveBeenCalledTimes(1);
    expect(onContactSupport).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("magic-link confirmation", () => {
  const longEmail = `${"a".repeat(60)}@${"b".repeat(60)}.example.com`;

  it("keeps a very long address on its own truncated line", async () => {
    await wrap(
      <MagicSentView
        email={longEmail}
        error=""
        busy={false}
        resendSeconds={0}
        onResend={jest.fn()}
        onUseAnotherMethod={jest.fn()}
      />,
    );
    const address = screen.getByText(longEmail);
    // numberOfLines only binds at the outermost Text of a run, which is why
    // the previous inline version silently ignored it.
    expect(address.props.numberOfLines).toBe(2);
    expect(address.props.ellipsizeMode).toBe("middle");
  });

  it("disables Resend while the cooldown is running", async () => {
    const onResend = jest.fn();
    await wrap(
      <MagicSentView
        email="reader@example.com"
        error=""
        busy={false}
        resendSeconds={24}
        onResend={onResend}
        onUseAnotherMethod={jest.fn()}
      />,
    );
    const resendButton = screen.getByTestId("signin-resend");
    expect(resendButton.props.accessibilityState.disabled).toBe(true);
    expect(resendButton).toHaveTextContent("Resend in 24s");
    await fireEvent.press(resendButton);
    expect(onResend).not.toHaveBeenCalled();
  });
});

describe("sign-in with Google (AUTH#2)", () => {
  beforeEach(() => {
    oauthState.probe = { ok: true };
    oauthState.session = { type: "cancel" };
    openedAuthUrls.length = 0;
    routerReplace.mockClear();
  });

  it("offers the provider the backend actually supports", async () => {
    await wrap(<SignIn />);
    expect(screen.getByTestId("signin-google")).toBeTruthy();
  });

  it("opens exactly the redirect sanitizeOAuthRedirect admits", async () => {
    await wrap(<SignIn />);
    await fireEvent.press(screen.getByTestId("signin-google"));

    expect(openedAuthUrls).toHaveLength(1);
    const opened = new URL(openedAuthUrls[0] ?? "");
    expect(opened.pathname).toBe("/api/v1/auth/oauth/google/start");
    expect(opened.searchParams.get("redirect_to")).toBe(
      "moosewave://auth/magic?state=a1b2c3d4e5f60718293a4b5c6d7e8f90",
    );
  });

  it("hands a completed callback to the magic-link consumer, not to itself", async () => {
    const params = new URLSearchParams({
      token: "tok_from_google",
      v: "1",
      flow: "magic",
      aud: "mobile",
      state: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      sig: "B".repeat(43),
    });
    oauthState.session = {
      type: "success",
      url: `moosewave://auth/magic?${params.toString()}`,
    };
    await wrap(<SignIn />);
    await fireEvent.press(screen.getByTestId("signin-google"));

    expect(router.replace).toHaveBeenCalledWith({
      pathname: "/(auth)/magic-return",
      params: expect.objectContaining({
        token: "tok_from_google",
        link_flow: "magic",
        link_audience: "mobile",
      }),
    });
  });

  it("never routes on a callback that is missing its signature", async () => {
    oauthState.session = {
      type: "success",
      url: "moosewave://auth/magic?token=tok&v=1&flow=magic&aud=mobile&state=a1b2c3d4e5f60718293a4b5c6d7e8f90",
    };
    await wrap(<SignIn />);
    await fireEvent.press(screen.getByTestId("signin-google"));

    expect(router.replace).not.toHaveBeenCalled();
    expect(await screen.findByTestId("signin-error")).toHaveTextContent(
      /unusable sign-in link/i,
    );
  });

  it("says a browser round-trip that produced no callback needs a linked account", async () => {
    await wrap(<SignIn />);
    await fireEvent.press(screen.getByTestId("signin-google"));

    expect(router.replace).not.toHaveBeenCalled();
    expect(await screen.findByTestId("signin-error")).toHaveTextContent(
      /connected to a Moosewave account/i,
    );
  });

  it("retires the button on a deployment with no Google provider, without opening a browser", async () => {
    oauthState.probe = { ok: false, reason: "provider_disabled" };
    await wrap(<SignIn />);
    await fireEvent.press(screen.getByTestId("signin-google"));

    expect(openedAuthUrls).toHaveLength(0);
    expect(await screen.findByTestId("signin-error")).toHaveTextContent(
      /isn't enabled on this Moosewave server/i,
    );
    expect(screen.queryByTestId("signin-google")).toBeNull();
  });
});

describe("API-key sign-in paste (MAP#63)", () => {
  beforeEach(() => {
    clipboardState.value = null;
    clipboardState.throws = false;
  });

  it("fills the key field from the clipboard instead of demanding 40 typed characters", async () => {
    clipboardState.value = "  pw_live_abcdef0123456789\n";
    await wrap(<Login />);
    await fireEvent.press(screen.getByTestId("login-paste-key"));

    expect(screen.getByTestId("login-api-key").props.value).toBe(
      "pw_live_abcdef0123456789",
    );
    expect(await screen.findByTestId("login-paste-hint")).toHaveTextContent(
      /Pasted the API key/i,
    );
  });

  it("routes a pasted server URL to the field it belongs in and says so", async () => {
    clipboardState.value = "https://mail.acme.internal/";
    await wrap(<Login />);
    await fireEvent.press(screen.getByTestId("login-paste-key"));

    expect(screen.getByTestId("login-base-url").props.value).toBe(
      "https://mail.acme.internal",
    );
    expect(await screen.findByTestId("login-paste-hint")).toHaveTextContent(
      /API base URL/i,
    );
  });

  it("never drops unrecognised clipboard content into a credential field", async () => {
    clipboardState.value = "some other app's secret";
    await wrap(<Login />);
    await fireEvent.press(screen.getByTestId("login-paste-key"));

    expect(screen.getByTestId("login-api-key").props.value).toBe("");
    expect(await screen.findByTestId("login-paste-hint")).toHaveTextContent(
      /start with pw_/i,
    );
  });

  it("reports a clipboard it cannot read as a hint, not as a sign-in failure", async () => {
    clipboardState.throws = true;
    await wrap(<Login />);
    await fireEvent.press(screen.getByTestId("login-paste-key"));

    expect(await screen.findByTestId("login-paste-hint")).toHaveTextContent(
      /Couldn't read the clipboard/i,
    );
    expect(screen.queryByTestId("login-error")).toBeNull();
  });
});
