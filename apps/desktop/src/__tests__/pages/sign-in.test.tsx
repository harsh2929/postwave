// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AuthMeResponse } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  beginReturn: vi.fn(),
  clearReturn: vi.fn(),
  dashboardUrl: vi.fn(),
  deviceSessionCancel: vi.fn(),
  deviceSessionConfirm: vi.fn(),
  desktopReturnUrl: vi.fn(),
  deviceSessionStart: vi.fn(),
  deviceSessionToken: vi.fn(),
  getAuthMe: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  magicLinkStart: vi.fn(),
  oauthAvailable: vi.fn(),
  oauthStartUrl: vi.fn(),
  openUrl: vi.fn(),
  qrToDataUrl: vi.fn(),
  rememberSession: vi.fn(),
  onForgotPassword: vi.fn(),
  onSignedIn: vi.fn(),
  onUseApiKey: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiAuth: {
    getAuthMe: mocks.getAuthMe,
    cancelDeviceSessionGrant: mocks.deviceSessionCancel,
    confirmDeviceSessionGrant: mocks.deviceSessionConfirm,
    startDeviceSessionGrant: mocks.deviceSessionStart,
    pollDeviceSessionGrant: mocks.deviceSessionToken,
    login: mocks.login,
    logoutSession: mocks.logout,
    magicLinkStart: mocks.magicLinkStart,
    oauthIsAvailable: mocks.oauthAvailable,
    oauthStartUrl: mocks.oauthStartUrl,
  },
  rememberSession: mocks.rememberSession,
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: mocks.qrToDataUrl },
}));

vi.mock("../../lib/auth-flow-state", () => ({
  beginMagicAuthReturnFlow: mocks.beginReturn,
  clearPendingMagicAuthReturnState: mocks.clearReturn,
  desktopMagicAuthReturnUrl: mocks.desktopReturnUrl,
}));

vi.mock("../../lib/dashboard-url", () => ({
  getDashboardUrl: mocks.dashboardUrl,
}));

vi.mock("../../lib/tauri", () => ({
  tauriApi: { openUrl: mocks.openUrl },
}));

vi.mock("../../components/AuthShell", () => ({
  AuthShell: ({
    children,
    footer,
    heading,
    headingSub,
  }: {
    children: ReactNode;
    footer?: ReactNode;
    heading: ReactNode;
    headingSub?: ReactNode;
  }) => (
    <main>
      <h1>{heading}</h1>
      <p>{headingSub}</p>
      {children}
      {footer}
    </main>
  ),
}));

vi.mock("../../components/LegalLinks", () => ({
  LegalLinks: () => <div>Legal links</div>,
}));

vi.mock("../../components/MfaChallenge", () => ({
  MfaChallenge: ({
    onSatisfied,
    onCancel,
  }: {
    onSatisfied: () => void;
    onCancel: () => void;
  }) => (
    <section aria-label="MFA challenge">
      <button type="button" onClick={onSatisfied}>
        Satisfy MFA
      </button>
      <button type="button" onClick={onCancel}>
        Cancel MFA
      </button>
    </section>
  ),
}));

vi.mock("../../components/TotpSetupModal", () => ({
  TotpSetupModal: ({
    open,
    onClose,
    onEnrolled,
  }: {
    open: boolean;
    onClose: () => void;
    onEnrolled: () => void;
  }) =>
    open ? (
      <section aria-label="MFA enrollment">
        <button type="button" onClick={onEnrolled}>
          Complete enrollment
        </button>
        <button type="button" onClick={onClose}>
          Cancel enrollment
        </button>
      </section>
    ) : null,
}));

vi.mock("../../pages/SignUp", () => ({
  SignUp: ({ onSwitchToSignIn }: { onSwitchToSignIn: () => void }) => (
    <section>
      Sign up
      <button type="button" onClick={onSwitchToSignIn}>
        Back to sign in
      </button>
    </section>
  ),
}));

import { SignIn } from "../../pages/SignIn";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function me(overrides: Partial<AuthMeResponse> = {}): AuthMeResponse {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "alice@example.test",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    totp_enabled: false,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mocks.beginReturn.mockReturnValue("state-one");
  mocks.dashboardUrl.mockReturnValue("https://app.moosewave.com");
  mocks.desktopReturnUrl.mockReturnValue(
    "moosewave://auth/magic?state=state-one",
  );
  mocks.oauthStartUrl.mockReturnValue(
    "https://api.example.test/api/v1/auth/oauth/google/start",
  );
  mocks.oauthAvailable.mockResolvedValue(false);
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.qrToDataUrl.mockResolvedValue("data:image/png;base64,cXI=");
  mocks.deviceSessionStart.mockResolvedValue({
    data: {
      device_code: "memory-only-device-secret",
      user_code: "ABCD-EFGH",
      grant_kind: "session",
      remember: false,
      verification_uri: "https://app.moosewave.com/cli/auth",
      verification_uri_complete:
        "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    },
  });
  mocks.deviceSessionCancel.mockResolvedValue({
    data: { ok: true, grant_kind: "session" },
  });
  mocks.deviceSessionConfirm.mockResolvedValue({
    data: {
      grant_kind: "session",
      session: true,
      confirmed: true,
      confirmation_required: false,
      remember: false,
      tenant_id: "tenant-1",
      email: "alice@example.test",
      expires_in: 43_200,
    },
  });
  mocks.deviceSessionToken.mockResolvedValue({
    error: {
      kind: "http",
      status: 400,
      code: "authorization_pending",
      message: "waiting",
    },
  });
  mocks.login.mockResolvedValue({
    data: { ok: true, user_id: "user-1", tenant_id: "tenant-1" },
  });
  mocks.getAuthMe.mockResolvedValue({ data: me() });
  mocks.magicLinkStart.mockResolvedValue({ data: { sent: true } });
  mocks.logout.mockResolvedValue({ data: undefined });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderSignIn(initialMethod?: "password" | "magic"): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <SignIn
        initialMethod={initialMethod}
        onSignedIn={mocks.onSignedIn}
        onUseApiKey={mocks.onUseApiKey}
        onForgotPassword={mocks.onForgotPassword}
      />,
    ),
  );
}

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(found).toBeDefined();
  return found!;
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = container?.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(found).not.toBeNull();
  return found!;
}

function methodRadio(method: "password" | "magic"): HTMLInputElement {
  const found = container?.querySelector<HTMLInputElement>(
    `input[name="sign-in-method"][value="${method}"]`,
  );
  expect(found).not.toBeNull();
  return found!;
}

function click(target: HTMLElement): void {
  act(() => target.click());
}

function setField(id: string, value: string): void {
  const input = container?.querySelector<HTMLInputElement>(`#${id}`);
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitForm(): void {
  const form = container?.querySelector("form");
  expect(form).not.toBeNull();
  act(() => {
    form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

describe("SignIn", () => {
  it("validates fields and serializes the exact password login through /me", async () => {
    const loginRequest = deferred<{
      data: { ok: true; user_id: string; tenant_id: string };
    }>();
    const meRequest = deferred<{ data: AuthMeResponse }>();
    mocks.login.mockReturnValue(loginRequest.promise);
    mocks.getAuthMe.mockReturnValue(meRequest.promise);
    renderSignIn();
    await flushEffects();

    submitForm();
    expect(container?.textContent).toContain("Enter your email address.");
    expect(container?.textContent).toContain("Enter your password.");
    expect(
      container?.querySelector("#auth-email")?.getAttribute("aria-invalid"),
    ).toBe("true");
    expect(document.activeElement).toBe(
      container?.querySelector("#auth-email"),
    );
    setField("auth-email", " alice@example.test ");
    setField("auth-password", "correct horse");
    submitForm();
    submitForm();

    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(mocks.login).toHaveBeenCalledWith({
      email: "alice@example.test",
      password: "correct horse",
      workspace_id: undefined,
    });
    expect(button("Signing in…").disabled).toBe(true);

    await act(async () => {
      loginRequest.resolve({
        data: { ok: true, user_id: "user-1", tenant_id: "tenant-1" },
      });
      await loginRequest.promise;
    });
    expect(mocks.getAuthMe).toHaveBeenCalledTimes(1);
    expect(
      container?.querySelector<HTMLInputElement>("#auth-password")?.value,
    ).toBe("");
    expect(button("Signing in…").disabled).toBe(true);

    const session = me();
    await act(async () => {
      meRequest.resolve({ data: session });
      await meRequest.promise;
    });
    expect(mocks.rememberSession).toHaveBeenCalledWith(session);
    expect(mocks.onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("selects a workspace with keyboard semantics and cancels MFA before exposing login", async () => {
    const logoutRequest = deferred<{ data: undefined }>();
    mocks.login
      .mockResolvedValueOnce({
        data: {
          needs_workspace: true,
          workspaces: [
            { tenant_id: "tenant-one", email: "one@example.test" },
            { tenant_id: "tenant-two", email: "two@example.test" },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { ok: true, user_id: "user-1", tenant_id: "tenant-two" },
      });
    mocks.getAuthMe.mockResolvedValue({
      error: {
        kind: "http",
        status: 403,
        code: "mfa_required",
        message: "MFA required",
      },
    });
    mocks.logout.mockReturnValue(logoutRequest.promise);
    renderSignIn();
    await flushEffects();
    setField("auth-email", "multi@example.test");
    setField("auth-password", "password");
    submitForm();
    await flushEffects();

    const radios = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
    );
    expect(radios).toHaveLength(2);
    expect(
      container
        ?.querySelector('[role="radiogroup"]')
        ?.getAttribute("aria-label"),
    ).toBe("Choose a workspace");
    radios[0]!.focus();
    act(() => {
      radios[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");

    submitForm();
    await flushEffects();
    expect(mocks.login).toHaveBeenNthCalledWith(2, {
      email: "multi@example.test",
      password: "password",
      workspace_id: "tenant-two",
    });
    expect(
      container?.querySelector('[aria-label="MFA challenge"]'),
    ).not.toBeNull();
    expect(mocks.rememberSession).not.toHaveBeenCalled();

    const cancelMfa = button("Cancel MFA");
    const satisfyMfa = button("Satisfy MFA");
    act(() => {
      cancelMfa.click();
      cancelMfa.click();
      satisfyMfa.click();
    });
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.onSignedIn).not.toHaveBeenCalled();
    expect(container?.querySelector('[aria-label="MFA challenge"]')).toBeNull();
    expect(container?.querySelector('[role="status"]')?.textContent).toContain(
      "Ending sign-in session",
    );

    await act(async () => {
      logoutRequest.resolve({ data: undefined });
      await logoutRequest.promise;
    });
    expect(mocks.rememberSession).toHaveBeenCalledWith(null);
    expect(container?.textContent).toContain("Sign in to Moosewave");
    expect(
      container?.querySelector<HTMLInputElement>("#auth-email")?.value,
    ).toBe("");
    expect(mocks.onSignedIn).not.toHaveBeenCalled();
  });

  it("caches a verified projection only after MFA is satisfied", async () => {
    const pending = me({ totp_enabled: true });
    mocks.getAuthMe.mockResolvedValue({ data: pending });
    renderSignIn();
    await flushEffects();
    setField("auth-email", "alice@example.test");
    setField("auth-password", "password");
    submitForm();
    await flushEffects();

    expect(mocks.rememberSession).not.toHaveBeenCalled();
    click(button("Satisfy MFA"));
    expect(mocks.rememberSession).toHaveBeenCalledWith(pending);
    expect(mocks.onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("uses the authoritative session MFA verdict instead of enrollment alone", async () => {
    const satisfied = me({
      totp_enabled: true,
      mfa_required: true,
      mfa_satisfied: true,
    });
    mocks.getAuthMe.mockResolvedValue({ data: satisfied });
    renderSignIn();
    await flushEffects();
    setField("auth-email", "alice@example.test");
    setField("auth-password", "password");
    submitForm();
    await flushEffects();

    expect(container?.querySelector('[aria-label="MFA challenge"]')).toBeNull();
    expect(mocks.rememberSession).toHaveBeenCalledWith(satisfied);
    expect(mocks.onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("offers enrollment when policy requires MFA but no factor exists", async () => {
    const unenrolled = me({
      totp_enabled: false,
      mfa_required: true,
      mfa_satisfied: false,
    });
    mocks.getAuthMe.mockResolvedValue({ data: unenrolled });
    renderSignIn();
    await flushEffects();
    setField("auth-email", "alice@example.test");
    setField("auth-password", "password");
    submitForm();
    await flushEffects();

    expect(
      container?.querySelector('[aria-label="MFA enrollment"]'),
    ).not.toBeNull();
    expect(mocks.rememberSession).not.toHaveBeenCalled();
    click(button("Complete enrollment"));
    expect(mocks.rememberSession).toHaveBeenCalledWith({
      ...unenrolled,
      totp_enabled: true,
      mfa_required: true,
      mfa_satisfied: true,
    });
    expect(mocks.onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("starts and resends magic links with a fresh secure state", async () => {
    const first = deferred<{ data: { sent: boolean } }>();
    mocks.beginReturn
      .mockReturnValueOnce("state-one")
      .mockReturnValueOnce("state-two");
    mocks.magicLinkStart
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ data: { sent: true } });
    renderSignIn();
    await flushEffects();
    setField("auth-email", " magic@example.test ");
    click(methodRadio("magic"));
    const sendLink = button("Send sign-in link");
    click(sendLink);
    click(sendLink);
    expect(mocks.magicLinkStart).toHaveBeenCalledTimes(1);
    expect(mocks.magicLinkStart).toHaveBeenCalledWith(
      "magic@example.test",
      "state-one",
    );

    await act(async () => {
      first.resolve({ data: { sent: true } });
      await first.promise;
    });
    expect(container?.textContent).toContain("Check your email");
    expect(container?.textContent).toContain("magic@example.test");
    expect(document.activeElement).toBe(
      container?.querySelector(".auth-state-card"),
    );
    click(button("Send another link"));
    await flushEffects();
    expect(mocks.magicLinkStart).toHaveBeenNthCalledWith(
      2,
      "magic@example.test",
      "state-two",
    );
  });

  it("fails closed when secure magic-link state cannot be created", async () => {
    mocks.beginReturn.mockImplementationOnce(() => {
      throw new Error("secure random unavailable");
    });
    renderSignIn();
    await flushEffects();
    setField("auth-email", "magic@example.test");
    click(methodRadio("magic"));
    click(button("Send sign-in link"));
    await flushEffects();

    expect(mocks.magicLinkStart).not.toHaveBeenCalled();
    expect(container?.textContent).toContain(
      "Unable to start a secure sign-in flow. Try again.",
    );
    expect(container?.textContent).not.toContain("secure random unavailable");
  });

  it("opens recovery directly on the dedicated magic-link request form", async () => {
    renderSignIn("magic");
    await flushEffects();

    expect(container?.textContent).toContain("Get a sign-in link");
    expect(container?.querySelector("#auth-password")).toBeNull();
    expect(button("Send sign-in link").disabled).toBe(false);
    click(methodRadio("password"));
    expect(container?.querySelector("#auth-password")).not.toBeNull();
  });

  it("provides password-manager metadata, reveal safety, and lossless method switching", async () => {
    renderSignIn();
    await flushEffects();

    const email = container?.querySelector<HTMLInputElement>("#auth-email");
    let password = container?.querySelector<HTMLInputElement>("#auth-password");
    expect(email?.name).toBe("email");
    expect(email?.autocomplete).toBe("username");
    expect(password?.name).toBe("password");
    expect(password?.autocomplete).toBe("current-password");
    expect(password?.getAttribute("autocapitalize")).toBe("none");
    expect(password?.getAttribute("autocorrect")).toBe("off");
    expect(password?.getAttribute("spellcheck")).toBe("false");
    expect(methodRadio("password").checked).toBe(true);

    const capsLockEvent = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(capsLockEvent, "getModifierState", {
      value: () => true,
    });
    act(() => {
      password?.dispatchEvent(capsLockEvent);
    });
    expect(container?.textContent).toContain("Caps Lock is on.");
    act(() => {
      password?.focus();
      password?.blur();
    });
    expect(container?.textContent).not.toContain("Caps Lock is on.");

    setField("auth-email", "  alice@example.test  ");
    setField("auth-password", " exact password bytes ");
    click(buttonByLabel("Show password"));
    password = container?.querySelector<HTMLInputElement>("#auth-password");
    expect(password?.type).toBe("text");
    expect(password?.value).toBe(" exact password bytes ");
    expect(buttonByLabel("Hide password").getAttribute("aria-pressed")).toBe(
      "true",
    );

    click(methodRadio("magic"));
    expect(methodRadio("magic").checked).toBe(true);
    expect(container?.querySelector("#auth-password")).toBeNull();
    click(methodRadio("password"));
    password = container?.querySelector<HTMLInputElement>("#auth-password");
    expect(password?.value).toBe(" exact password bytes ");
    expect(password?.type).toBe("password");
    expect(buttonByLabel("Show password").getAttribute("aria-pressed")).toBe(
      "false",
    );

    const forgot = button("Forgot password?");
    const reveal = buttonByLabel("Show password");
    expect(
      forgot.compareDocumentPosition(password!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      password!.compareDocumentPosition(reveal) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    click(forgot);
    expect(mocks.onForgotPassword).toHaveBeenCalledWith("alice@example.test");

    click(button("Set up with an API key"));
    expect(mocks.onUseApiKey).toHaveBeenCalledTimes(1);
    click(button("Create account"));
    expect(container?.textContent).toContain("Sign up");
  });

  it("maps invalid credentials to safe copy, clears the password, and focuses recovery", async () => {
    mocks.login.mockResolvedValue({
      error: {
        kind: "http",
        status: 401,
        code: "invalid_credentials",
        message: "database detail that must not reach the user",
      },
    });
    renderSignIn();
    await flushEffects();
    setField("auth-email", "alice@example.test");
    setField("auth-password", "wrong password");
    click(buttonByLabel("Show password"));
    submitForm();
    await flushEffects();

    const password =
      container?.querySelector<HTMLInputElement>("#auth-password");
    expect(password?.value).toBe("");
    expect(password?.type).toBe("password");
    expect(document.activeElement).toBe(password);
    expect(container?.textContent).toContain("Email or password is incorrect.");
    expect(container?.textContent).not.toContain("database detail");

    setField("auth-password", "corrected password");
    expect(container?.textContent).not.toContain(
      "Email or password is incorrect.",
    );
  });
});

describe("SignIn device-session approval", () => {
  it("accepts only the locally configured public-app approval origin", async () => {
    mocks.dashboardUrl.mockReturnValue("https://admin.selfhost.example");
    mocks.deviceSessionStart.mockResolvedValueOnce({
      data: {
        device_code: "memory-only-device-secret",
        user_code: "ABCD-EFGH",
        grant_kind: "session",
        remember: false,
        verification_uri: "https://admin.selfhost.example/cli/auth",
        verification_uri_complete:
          "https://admin.selfhost.example/cli/auth?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      },
    });
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    expect(container?.textContent).toContain("ABCD-EFGH");
    expect(mocks.qrToDataUrl).toHaveBeenCalledWith(
      "https://admin.selfhost.example/cli/auth?user_code=ABCD-EFGH",
      expect.any(Object),
    );
  });

  it("rejects a QR URL that does not match the public approval code", async () => {
    mocks.deviceSessionStart.mockResolvedValueOnce({
      data: {
        device_code: "memory-only-device-secret",
        user_code: "ABCD-EFGH",
        grant_kind: "session",
        remember: false,
        verification_uri: "https://app.moosewave.com/cli/auth",
        verification_uri_complete:
          "https://app.moosewave.com/cli/auth?user_code=WXYZ-1234",
        expires_in: 600,
        interval: 5,
      },
    });
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    expect(container?.textContent).toContain("Device sign-in unavailable");
    expect(container?.textContent).not.toContain("ABCD-EFGH");
    expect(mocks.qrToDataUrl).not.toHaveBeenCalled();
    expect(mocks.deviceSessionToken).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "an attacker-controlled origin",
      verificationUri: "https://evil.example/cli/auth",
      verificationUriComplete:
        "https://evil.example/cli/auth?user_code=ABCD-EFGH",
    },
    {
      label: "a non-canonical approval path",
      verificationUri: "https://app.moosewave.com/device/approve",
      verificationUriComplete:
        "https://app.moosewave.com/device/approve?user_code=ABCD-EFGH",
    },
    {
      label: "an extra query parameter",
      verificationUri: "https://app.moosewave.com/cli/auth",
      verificationUriComplete:
        "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH&next=%2Fapp",
    },
    {
      label: "duplicate approval-code parameters",
      verificationUri: "https://app.moosewave.com/cli/auth",
      verificationUriComplete:
        "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH&user_code=ABCD-EFGH",
    },
    {
      label: "a percent-encoded device secret",
      verificationUri: "https://app.moosewave.com/cli/auth",
      verificationUriComplete:
        "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH&state=%6D%65%6D%6F%72%79%2D%6F%6E%6C%79%2D%64%65%76%69%63%65%2D%73%65%63%72%65%74",
    },
  ])("rejects $label in server-provided approval URLs", async (urls) => {
    mocks.deviceSessionStart.mockResolvedValueOnce({
      data: {
        device_code: "memory-only-device-secret",
        user_code: "ABCD-EFGH",
        grant_kind: "session",
        remember: false,
        verification_uri: urls.verificationUri,
        verification_uri_complete: urls.verificationUriComplete,
        expires_in: 600,
        interval: 5,
      },
    });
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    expect(container?.textContent).toContain("Device sign-in unavailable");
    expect(mocks.qrToDataUrl).not.toHaveBeenCalled();
    expect(mocks.deviceSessionToken).not.toHaveBeenCalled();
  });

  it("shows only the public QR/code and follows pending + slow_down before signing in", async () => {
    vi.useFakeTimers();
    mocks.deviceSessionToken
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 400,
          code: "authorization_pending",
          message: "waiting",
        },
      })
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 400,
          code: "slow_down",
          message: "too fast",
        },
      })
      .mockResolvedValueOnce({
        data: {
          grant_kind: "session",
          session: true,
          confirmation_required: true,
          confirmation_expires_in: 120,
          remember: false,
          tenant_id: "tenant-1",
          email: "alice@example.test",
          expires_in: 43_200,
        },
      });
    renderSignIn();
    await flushEffects();

    click(button("Sign in with another device"));
    await flushEffects();

    expect(mocks.deviceSessionStart).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    );
    expect(container?.textContent).toContain("ABCD-EFGH");
    expect(container?.textContent).toContain(
      "https://app.moosewave.com/cli/auth",
    );
    expect(container?.textContent).not.toContain("memory-only-device-secret");
    expect(mocks.qrToDataUrl).toHaveBeenCalledWith(
      "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
      expect.objectContaining({ width: 224 }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.deviceSessionToken).toHaveBeenCalledTimes(1);
    expect(mocks.deviceSessionToken).toHaveBeenLastCalledWith(
      "memory-only-device-secret",
      expect.any(AbortSignal),
    );

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.deviceSessionToken).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(mocks.deviceSessionToken).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    await flushEffects();
    expect(mocks.deviceSessionToken).toHaveBeenCalledTimes(3);
    expect(mocks.deviceSessionConfirm).toHaveBeenCalledWith(
      "memory-only-device-secret",
      expect.any(AbortSignal),
    );
    expect(mocks.deviceSessionConfirm.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getAuthMe.mock.invocationCallOrder[0]!,
    );
    expect(mocks.getAuthMe).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.rememberSession).toHaveBeenCalledWith(me());
    expect(mocks.onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("routes an approved session through the existing MFA gate", async () => {
    vi.useFakeTimers();
    const pendingMfa = me({
      auth_provider: "device_grant",
      totp_enabled: true,
    });
    mocks.deviceSessionToken.mockResolvedValueOnce({
      data: {
        grant_kind: "session",
        session: true,
        confirmation_required: true,
        confirmation_expires_in: 120,
        remember: false,
        tenant_id: "tenant-1",
        email: "alice@example.test",
        expires_in: 43_200,
      },
    });
    mocks.getAuthMe.mockResolvedValue({ data: pendingMfa });
    renderSignIn();
    await flushEffects();

    click(button("Sign in with another device"));
    await flushEffects();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await flushEffects();

    expect(
      container?.querySelector('[aria-label="MFA challenge"]'),
    ).not.toBeNull();
    expect(mocks.rememberSession).not.toHaveBeenCalled();
    click(button("Satisfy MFA"));
    expect(mocks.rememberSession).toHaveBeenCalledWith(pendingMfa);
    expect(mocks.onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("revokes the exact grant when a provisional response escalates session lifetime", async () => {
    vi.useFakeTimers();
    mocks.deviceSessionToken.mockResolvedValueOnce({
      data: {
        grant_kind: "session",
        session: true,
        confirmation_required: true,
        confirmation_expires_in: 120,
        remember: true,
        tenant_id: "tenant-1",
        email: "alice@example.test",
        expires_in: 30 * 24 * 60 * 60,
      },
    });
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await flushEffects();

    expect(mocks.deviceSessionCancel).toHaveBeenCalledWith(
      "memory-only-device-secret",
    );
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.rememberSession).not.toHaveBeenCalled();
    expect(mocks.onSignedIn).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Device sign-in unavailable");
  });

  it("keeps retrying transport failures but stops on an expired grant", async () => {
    vi.useFakeTimers();
    mocks.deviceSessionToken
      .mockResolvedValueOnce({
        error: { kind: "network", message: "socket details" },
      })
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 400,
          code: "expired_token",
          message: "server detail",
        },
      });
    mocks.getAuthMe.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 401,
        code: "unauthorized",
        message: "not signed in",
      },
    });
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container?.textContent).toContain("Connection interrupted");
    expect(container?.textContent).not.toContain("socket details");

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.getAuthMe).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Code expired");
    expect(container?.textContent).not.toContain("server detail");
    expect(container?.textContent).not.toContain("ABCD-EFGH");
    expect(button("Get a new code")).toBeDefined();
  });

  it("retries the same device code after a lost response and accepts the durable replay", async () => {
    vi.useFakeTimers();
    const recoveredSession = me({ auth_provider: "device_grant" });
    mocks.deviceSessionToken
      .mockResolvedValueOnce({
        error: { kind: "network", message: "response was lost" },
      })
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 503,
          code: "session_retry",
          message: "session replay is temporarily unavailable",
        },
      })
      .mockResolvedValueOnce({
        data: {
          grant_kind: "session",
          session: true,
          confirmation_required: true,
          confirmation_expires_in: 120,
          remember: false,
          tenant_id: "tenant-1",
          email: "alice@example.test",
          expires_in: 43_200,
        },
      });
    mocks.getAuthMe.mockResolvedValueOnce({ data: recoveredSession });
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container?.textContent).toContain("Connection interrupted");
    expect(mocks.getAuthMe).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container?.textContent).toContain("Connection interrupted");
    expect(mocks.getAuthMe).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await flushEffects();

    expect(mocks.deviceSessionToken).toHaveBeenNthCalledWith(
      1,
      "memory-only-device-secret",
      expect.any(AbortSignal),
    );
    expect(mocks.deviceSessionToken).toHaveBeenNthCalledWith(
      2,
      "memory-only-device-secret",
      expect.any(AbortSignal),
    );
    expect(mocks.deviceSessionToken).toHaveBeenNthCalledWith(
      3,
      "memory-only-device-secret",
      expect.any(AbortSignal),
    );
    expect(mocks.deviceSessionConfirm).toHaveBeenCalledWith(
      "memory-only-device-secret",
      expect.any(AbortSignal),
    );
    expect(mocks.getAuthMe).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.rememberSession).toHaveBeenCalledWith(recoveredSession);
    expect(mocks.onSignedIn).toHaveBeenCalledTimes(1);
    expect(container?.textContent).not.toContain("Code expired");
  });

  it("retries confirmation with the same device code before reading the session", async () => {
    vi.useFakeTimers();
    const recoveredSession = me({ auth_provider: "device_grant" });
    mocks.deviceSessionToken.mockResolvedValueOnce({
      data: {
        grant_kind: "session",
        session: true,
        confirmation_required: true,
        confirmation_expires_in: 120,
        remember: false,
        tenant_id: "tenant-1",
        email: "alice@example.test",
        expires_in: 43_200,
      },
    });
    mocks.deviceSessionConfirm
      .mockResolvedValueOnce({
        error: { kind: "network", message: "confirmation response lost" },
      })
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 503,
          code: "session_retry",
          message: "confirmation replay unavailable",
        },
      })
      .mockResolvedValueOnce({
        data: {
          grant_kind: "session",
          session: true,
          confirmed: true,
          confirmation_required: false,
          remember: false,
          tenant_id: "tenant-1",
          email: "alice@example.test",
          expires_in: 43_200,
        },
      });
    mocks.getAuthMe.mockResolvedValueOnce({ data: recoveredSession });
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await flushEffects();
    expect(mocks.deviceSessionConfirm).toHaveBeenCalledTimes(1);
    expect(mocks.getAuthMe).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await flushEffects();
    expect(mocks.deviceSessionConfirm).toHaveBeenCalledTimes(2);
    expect(mocks.getAuthMe).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await flushEffects();
    expect(mocks.deviceSessionConfirm).toHaveBeenCalledTimes(3);
    for (let call = 1; call <= 3; call += 1) {
      expect(mocks.deviceSessionConfirm).toHaveBeenNthCalledWith(
        call,
        "memory-only-device-secret",
        expect.any(AbortSignal),
      );
    }
    expect(mocks.deviceSessionConfirm.mock.invocationCallOrder[2]).toBeLessThan(
      mocks.getAuthMe.mock.invocationCallOrder[0]!,
    );
    expect(mocks.rememberSession).toHaveBeenCalledWith(recoveredSession);
    expect(mocks.onSignedIn).toHaveBeenCalledTimes(1);
    expect(mocks.deviceSessionCancel).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it("revokes the exact grant when confirmation expires", async () => {
    vi.useFakeTimers();
    mocks.deviceSessionToken.mockResolvedValueOnce({
      data: {
        grant_kind: "session",
        session: true,
        confirmation_required: true,
        confirmation_expires_in: 120,
        remember: false,
        tenant_id: "tenant-1",
        email: "alice@example.test",
        expires_in: 43_200,
      },
    });
    mocks.deviceSessionConfirm.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 400,
        code: "expired_token",
        message: "confirmation expired",
      },
    });
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await flushEffects();

    expect(mocks.deviceSessionCancel).toHaveBeenCalledWith(
      "memory-only-device-secret",
    );
    expect(mocks.getAuthMe).not.toHaveBeenCalled();
    expect(mocks.rememberSession).not.toHaveBeenCalled();
    expect(mocks.onSignedIn).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Code expired");
  });

  it("aborts confirmation and revokes only the exact grant when cancelled", async () => {
    vi.useFakeTimers();
    let confirmationSignal: AbortSignal | undefined;
    mocks.deviceSessionToken.mockResolvedValueOnce({
      data: {
        grant_kind: "session",
        session: true,
        confirmation_required: true,
        confirmation_expires_in: 120,
        remember: false,
        tenant_id: "tenant-1",
        email: "alice@example.test",
        expires_in: 43_200,
      },
    });
    mocks.deviceSessionConfirm.mockImplementationOnce(
      (_deviceCode: string, signal: AbortSignal) => {
        confirmationSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                error: {
                  kind: "network",
                  code: "aborted",
                  message: "cancelled",
                },
              }),
            { once: true },
          );
        });
      },
    );
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await flushEffects();
    expect(mocks.deviceSessionConfirm).toHaveBeenCalledTimes(1);
    expect(confirmationSignal?.aborted).toBe(false);

    click(button("Cancel and sign out"));
    await flushEffects();

    expect(confirmationSignal?.aborted).toBe(true);
    expect(mocks.deviceSessionCancel).toHaveBeenCalledWith(
      "memory-only-device-secret",
    );
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.getAuthMe).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Sign in to Moosewave");
  });

  it("expires at the grant deadline instead of waiting through another poll interval", async () => {
    vi.useFakeTimers();
    mocks.deviceSessionStart.mockResolvedValueOnce({
      data: {
        device_code: "memory-only-device-secret",
        user_code: "ABCD-EFGH",
        grant_kind: "session",
        remember: false,
        verification_uri: "https://app.moosewave.com/cli/auth",
        verification_uri_complete:
          "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
        expires_in: 6,
        interval: 5,
      },
    });
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.deviceSessionToken).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("Waiting for approval");

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(container?.textContent).toContain("Code expired");
    expect(mocks.deviceSessionToken).toHaveBeenCalledTimes(1);
  });

  it("aborts polling and forgets the code when the user cancels", async () => {
    vi.useFakeTimers();
    let flowSignal: AbortSignal | undefined;
    mocks.deviceSessionStart.mockImplementationOnce(
      async (signal: AbortSignal) => {
        flowSignal = signal;
        return {
          data: {
            device_code: "memory-only-device-secret",
            user_code: "ABCD-EFGH",
            grant_kind: "session",
            remember: false,
            verification_uri: "https://app.moosewave.com/cli/auth",
            verification_uri_complete:
              "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 5,
          },
        };
      },
    );
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    click(button("Use another sign-in method"));
    await flushEffects();
    expect(flowSignal?.aborted).toBe(true);
    expect(mocks.deviceSessionCancel).toHaveBeenCalledWith(
      "memory-only-device-secret",
    );
    expect(container?.textContent).toContain("Sign in to Moosewave");
    expect(container?.textContent).not.toContain("ABCD-EFGH");

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.deviceSessionToken).not.toHaveBeenCalled();
  });

  it("aborts the memory-only flow when the sign-in surface unmounts", async () => {
    vi.useFakeTimers();
    let flowSignal: AbortSignal | undefined;
    mocks.deviceSessionStart.mockImplementationOnce(
      async (signal: AbortSignal) => {
        flowSignal = signal;
        return {
          data: {
            device_code: "memory-only-device-secret",
            user_code: "ABCD-EFGH",
            grant_kind: "session",
            remember: false,
            verification_uri: "https://app.moosewave.com/cli/auth",
            verification_uri_complete:
              "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 5,
          },
        };
      },
    );
    renderSignIn();
    await flushEffects();
    click(button("Sign in with another device"));
    await flushEffects();

    act(() => root?.unmount());
    root = null;
    expect(flowSignal?.aborted).toBe(true);
    expect(mocks.deviceSessionCancel).toHaveBeenCalledWith(
      "memory-only-device-secret",
    );
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.deviceSessionToken).not.toHaveBeenCalled();
  });
});

describe("SignIn external authentication and lifecycle", () => {
  it("locks competing credentials while Google is pending and restores focus after cancel", async () => {
    mocks.oauthAvailable.mockResolvedValue(true);
    renderSignIn();
    await flushEffects();
    click(button("Continue with Google"));
    await flushEffects();

    expect(
      container?.querySelector<HTMLInputElement>("#auth-email")?.disabled,
    ).toBe(true);
    expect(
      methodRadio("password").closest("fieldset")?.hasAttribute("disabled"),
    ).toBe(true);
    const cancel = buttonByLabel("Cancel Google sign-in");
    expect(cancel.disabled).toBe(false);

    click(cancel);
    await flushEffects();
    expect(
      container?.querySelector<HTMLInputElement>("#auth-email")?.disabled,
    ).toBe(false);
    expect(document.activeElement).toBe(button("Continue with Google"));
    expect(mocks.clearReturn).toHaveBeenCalled();
  });

  it("starts Google OAuth exactly and keeps only the newest focus probe", async () => {
    const older = deferred<{ data: AuthMeResponse }>();
    const newer = deferred<{ data: AuthMeResponse }>();
    mocks.oauthAvailable.mockResolvedValue(true);
    mocks.getAuthMe
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    renderSignIn();
    await flushEffects();
    click(button("Continue with Google"));
    await flushEffects();

    expect(mocks.beginReturn).toHaveBeenCalledTimes(1);
    expect(mocks.desktopReturnUrl).toHaveBeenCalledWith("state-one");
    expect(mocks.oauthStartUrl).toHaveBeenCalledWith(
      "google",
      "moosewave://auth/magic?state=state-one",
    );
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/auth/oauth/google/start",
    );
    expect(container?.textContent).toContain("Finish signing in with Google");
    expect(container?.textContent).toContain(
      "Complete the browser step, then return to Moosewave.",
    );

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.getAuthMe).toHaveBeenCalledTimes(2);
    const current = me({ auth_provider: "google" });
    await act(async () => {
      newer.resolve({ data: current });
      await newer.promise;
    });
    expect(mocks.rememberSession).toHaveBeenCalledWith(current);
    expect(mocks.onSignedIn).toHaveBeenCalledTimes(1);

    await act(async () => {
      older.resolve({ data: me({ totp_enabled: true }) });
      await older.promise;
    });
    expect(mocks.onSignedIn).toHaveBeenCalledTimes(1);
    expect(container?.querySelector('[aria-label="MFA challenge"]')).toBeNull();
  });

  it("surfaces OAuth launch failures without retaining a pending flow", async () => {
    mocks.oauthAvailable.mockResolvedValue(true);
    mocks.openUrl.mockRejectedValue(new Error("shell details must not leak"));
    renderSignIn();
    await flushEffects();
    click(button("Continue with Google"));
    await flushEffects();

    expect(container?.textContent).toContain(
      "Unable to open the secure sign-in page. Try again.",
    );
    expect(container?.textContent).not.toContain("shell details");
    expect(container?.textContent).not.toContain(
      "Finish signing in with Google",
    );
    expect(mocks.clearReturn).toHaveBeenCalled();
    expect(document.activeElement).toBe(button("Continue with Google"));
  });

  it("does not enter the app when session verification fails", async () => {
    mocks.getAuthMe.mockResolvedValue({
      error: { kind: "network", message: "gateway offline" },
    });
    renderSignIn();
    await flushEffects();
    setField("auth-email", "alice@example.test");
    setField("auth-password", "password");
    submitForm();
    await flushEffects();

    expect(container?.textContent).toContain(
      "Moosewave couldn't connect. Check your connection and try again.",
    );
    expect(container?.textContent).not.toContain("gateway offline");
    expect(mocks.rememberSession).not.toHaveBeenCalled();
    expect(mocks.onSignedIn).not.toHaveBeenCalled();

    setField("auth-password", "retry password");
    expect(container?.textContent).not.toContain("Moosewave couldn't connect");
  });

  it("suppresses password and OAuth completions after unmount", async () => {
    const loginRequest = deferred<{
      data: { ok: true; user_id: string; tenant_id: string };
    }>();
    mocks.login.mockReturnValue(loginRequest.promise);
    renderSignIn();
    await flushEffects();
    setField("auth-email", "alice@example.test");
    setField("auth-password", "password");
    submitForm();
    act(() => root?.unmount());
    root = null;

    await act(async () => {
      loginRequest.resolve({
        data: { ok: true, user_id: "user-1", tenant_id: "tenant-1" },
      });
      await loginRequest.promise;
    });
    expect(mocks.getAuthMe).not.toHaveBeenCalled();
    expect(mocks.rememberSession).not.toHaveBeenCalled();
    expect(mocks.onSignedIn).not.toHaveBeenCalled();

    mocks.oauthAvailable.mockResolvedValue(true);
    const focusRequest = deferred<{ data: AuthMeResponse }>();
    mocks.getAuthMe.mockReturnValue(focusRequest.promise);
    renderSignIn();
    await flushEffects();
    click(button("Continue with Google"));
    await flushEffects();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => root?.unmount());
    root = null;
    await act(async () => {
      focusRequest.resolve({ data: me({ auth_provider: "google" }) });
      await focusRequest.promise;
    });
    expect(mocks.rememberSession).not.toHaveBeenCalled();
    expect(mocks.onSignedIn).not.toHaveBeenCalled();
  });

  it("does not advertise unsupported passkeys and removes the legacy ratchet", async () => {
    renderSignIn();
    await flushEffects();
    expect(container?.textContent?.toLowerCase()).not.toContain("passkey");

    const source = readFileSync("src/pages/SignIn.tsx", "utf8");
    expect(source).toContain("useSignInController");
    expect(source).toContain("SignInControllerBoundary");
    const budgets = readFileSync(
      "scripts/function-quality-budgets.json",
      "utf8",
    );
    expect(budgets).not.toContain('"src/pages/SignIn.tsx"');
  });
});
