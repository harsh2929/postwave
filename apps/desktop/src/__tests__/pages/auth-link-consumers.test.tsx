// @vitest-environment happy-dom

import { act, StrictMode, type ReactNode } from "react";
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

const mocks = vi.hoisted(() => ({
  getAuthMe: vi.fn(),
  magicLinkConsume: vi.fn(),
  passwordResetConfirm: vi.fn(),
  rememberSession: vi.fn(),
  onDone: vi.fn(),
  onRequestNew: vi.fn(),
  onSignedIn: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiAuth: {
    getAuthMe: mocks.getAuthMe,
    magicLinkConsume: mocks.magicLinkConsume,
    passwordResetConfirm: mocks.passwordResetConfirm,
  },
  rememberSession: mocks.rememberSession,
}));

vi.mock("../../components/AuthShell", () => ({
  AuthShell: ({
    heading,
    headingSub,
    children,
  }: {
    heading: ReactNode;
    headingSub?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{heading}</h1>
      <p>{headingSub}</p>
      {children}
    </main>
  ),
}));

vi.mock("../../pages/AuthLinkRecovery", () => ({
  AuthLinkRecovery: ({
    reason,
    onRetry,
  }: {
    reason: string;
    onRetry?: () => void;
  }) => (
    <section data-testid="recovery">
      <span>{reason}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </section>
  ),
}));

import type { DesktopAuthLinkProof } from "../../lib/auth-link-contract";
import { MagicLinkReturn } from "../../pages/MagicLinkReturn";
import { PasswordResetConfirm } from "../../pages/PasswordResetConfirm";

const magicProof: DesktopAuthLinkProof = {
  token: "magic-token",
  link_version: 1,
  link_flow: "magic",
  link_audience: "mobile",
  state: "desktop_magic_123456",
  link_signature: "A".repeat(43),
};

const resetProof: DesktopAuthLinkProof = {
  ...magicProof,
  token: "reset-token",
  link_flow: "reset",
};

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setInput(id: string, value: string): void {
  const input = container.querySelector(`#${id}`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`missing #${id}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("native auth-link consumers", () => {
  it("consumes a magic token once under StrictMode and verifies the session", async () => {
    vi.useFakeTimers();
    mocks.magicLinkConsume.mockResolvedValue({
      data: { user_id: "user-1", tenant_id: "tenant-1" },
    });
    const me = {
      user_id: "user-1",
      tenant_id: "tenant-1",
      email: "person@example.test",
      role: "admin",
      auth_provider: "magic_link",
      email_verified: true,
    };
    mocks.getAuthMe.mockResolvedValue({ data: me });

    act(() =>
      root.render(
        <StrictMode>
          <MagicLinkReturn
            proof={magicProof}
            onSignedIn={mocks.onSignedIn}
            onRequestNewLink={mocks.onRequestNew}
            onCancel={mocks.onDone}
          />
        </StrictMode>,
      ),
    );
    await settle();

    expect(mocks.magicLinkConsume).toHaveBeenCalledOnce();
    expect(mocks.getAuthMe).toHaveBeenCalledOnce();
    expect(mocks.rememberSession).toHaveBeenCalledWith(me);
    await act(async () => vi.advanceTimersByTime(500));
    expect(mocks.onSignedIn).toHaveBeenCalledOnce();
  });

  it("renders an honest replay/expiry result for an invalid magic token", async () => {
    mocks.magicLinkConsume.mockResolvedValue({
      error: {
        kind: "http",
        status: 400,
        code: "invalid_token",
        message: "invalid_token",
      },
    });

    act(() =>
      root.render(
        <MagicLinkReturn
          proof={magicProof}
          onSignedIn={mocks.onSignedIn}
          onRequestNewLink={mocks.onRequestNew}
          onCancel={mocks.onDone}
        />,
      ),
    );
    await settle();

    expect(
      container.querySelector('[data-testid="recovery"]')?.textContent,
    ).toBe("expired_or_used");
    expect(mocks.getAuthMe).not.toHaveBeenCalled();
  });

  it("keeps reset input recoverable after a temporary confirmation failure", async () => {
    mocks.passwordResetConfirm.mockResolvedValue({
      error: {
        kind: "network",
        code: "network_error",
        message: "secret transport detail",
      },
    });
    act(() =>
      root.render(
        <PasswordResetConfirm
          proof={resetProof}
          onDone={mocks.onDone}
          onRequestNewLink={mocks.onRequestNew}
        />,
      ),
    );
    setInput("prc-pw", "VeryLongPassword1!");
    setInput("prc-confirm", "VeryLongPassword1!");
    const form = container.querySelector("form");
    if (!(form instanceof HTMLFormElement))
      throw new Error("missing reset form");
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(mocks.passwordResetConfirm).toHaveBeenCalledWith(
      resetProof,
      "VeryLongPassword1!",
    );
    expect(
      container.querySelector('[data-testid="recovery"]')?.textContent,
    ).toContain("temporary_failure");

    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    act(() => retry?.click());
    expect((container.querySelector("#prc-pw") as HTMLInputElement).value).toBe(
      "VeryLongPassword1!",
    );
  });
});
