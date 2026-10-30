// @vitest-environment happy-dom

import { act } from "react";
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
  approve: vi.fn(),
  deny: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiAuth: {
    approveDeviceGrant: mocks.approve,
    denyDeviceGrant: mocks.deny,
    inspectDeviceGrant: mocks.inspect,
  },
}));

import { DeviceApprovalSection } from "../../components/settings/DeviceApprovalSection";

const ACCOUNT: AuthMeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "alice@example.test",
  role: "owner",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme Workspace",
  workspace_slug: "acme",
  totp_enabled: true,
  mfa_required: true,
  mfa_satisfied: true,
};

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
  const disclosure = {
    grant_kind: "session",
    account: {
      email: "approved-account@example.test",
      workspace_name: "Approved Workspace",
      workspace_slug: "approved-workspace",
    },
    device: {
      device_label: "Moosewave Desktop on Windows",
      device_type: "desktop",
      device_os: "Windows",
      device_client: "Moosewave Desktop",
    },
    remember: false,
    expires_in: 540,
    consent_token: "opaque-consent-token",
  };
  mocks.inspect.mockResolvedValue({ data: disclosure });
  mocks.approve.mockResolvedValue({ data: { ...disclosure, ok: true } });
  mocks.deny.mockResolvedValue({ data: { ...disclosure, ok: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderSection(me: AuthMeResponse | null = ACCOUNT): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<DeviceApprovalSection me={me} />));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function enterCode(value = "abcd1234"): void {
  const input = container?.querySelector<HTMLInputElement>(
    "#settings-device-code",
  );
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("DeviceApprovalSection", () => {
  it("inspects first and discloses device, account, workspace, and access", async () => {
    renderSection();
    enterCode();
    expect(
      container?.querySelector<HTMLInputElement>("#settings-device-code")
        ?.value,
    ).toBe("ABCD-1234");

    act(() => button("Review request").click());
    await flush();

    expect(mocks.inspect).toHaveBeenCalledWith("ABCD-1234");
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Reported requesting device");
    expect(container?.textContent).toContain("Moosewave Desktop on Windows");
    expect(container?.textContent).toContain("approved-account@example.test");
    expect(container?.textContent).toContain("Approved Workspace");
    expect(container?.textContent).toContain("up to 12 hours");
    expect(container?.textContent).toContain("ABCD-1234");
    expect(container?.textContent).not.toContain("opaque-consent-token");
    expect(container?.textContent).toContain(
      "Trust the matching code, not the reported device label.",
    );

    act(() => button("Approve sign-in").click());
    await flush();
    expect(mocks.approve).toHaveBeenCalledWith(
      "ABCD-1234",
      "opaque-consent-token",
    );
    expect(container?.textContent).toContain("Device approved");
  });

  it("sends an explicit denial and reports it to the approver", async () => {
    renderSection();
    enterCode();
    act(() => button("Review request").click());
    await flush();

    act(() => button("Deny request").click());
    await flush();

    expect(mocks.deny).toHaveBeenCalledWith(
      "ABCD-1234",
      "opaque-consent-token",
    );
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Request denied");
  });

  it("discloses API-key scopes and MFA before authorization", async () => {
    mocks.inspect.mockResolvedValueOnce({
      data: {
        grant_kind: "api_key",
        account: {
          email: "alice@example.test",
          workspace_name: "Acme Workspace",
          workspace_slug: "acme",
        },
        device: {
          device_label: "Moosewave CLI on macOS",
          device_type: "cli",
          device_os: "macOS",
          device_client: "Moosewave CLI",
        },
        remember: false,
        expires_in: 540,
        scopes: ["campaigns:read", "campaigns:write"],
        requires_mfa: true,
      },
    });
    renderSection();
    enterCode();
    act(() => button("Review request").click());
    await flush();

    expect(container?.textContent).toContain("Moosewave API key");
    expect(container?.textContent).toContain("campaigns:read");
    expect(container?.textContent).toContain("campaigns:write");
    expect(container?.textContent).toContain(
      "Two-factor verification is required before approval.",
    );
    expect(button("Authorize API key").disabled).toBe(false);
  });

  it("denies an API-key request without inventing a session consent proof", async () => {
    const disclosure = {
      grant_kind: "api_key",
      account: {
        email: "alice@example.test",
        workspace_name: "Acme Workspace",
      },
      device: {
        device_label: "Moosewave CLI on macOS",
        device_type: "cli",
        device_os: "macOS",
      },
      remember: false,
      expires_in: 540,
      scopes: ["campaigns:read"],
      requires_mfa: false,
    };
    mocks.inspect.mockResolvedValueOnce({ data: disclosure });
    mocks.deny.mockResolvedValueOnce({
      data: {
        ...disclosure,
        scopes: undefined,
        ok: true,
      },
    });
    renderSection();
    enterCode();
    act(() => button("Review request").click());
    await flush();

    act(() => button("Deny request").click());
    await flush();

    expect(mocks.deny).toHaveBeenCalledWith("ABCD-1234", undefined);
    expect(container?.textContent).toContain("Request denied");
  });

  it("fails closed on an incomplete disclosure", async () => {
    mocks.inspect.mockResolvedValue({
      data: {
        grant_kind: "session",
        account: { email: "alice@example.test" },
        device: {},
        remember: false,
        expires_in: 540,
      },
    });
    renderSection();
    enterCode();
    act(() => button("Review request").click());
    await flush();

    expect(container?.textContent).toContain("incomplete device disclosure");
    expect(container?.textContent).not.toContain("Approve sign-in");
  });

  it("fails closed when a session disclosure omits its consent proof", async () => {
    mocks.inspect.mockResolvedValue({
      data: {
        grant_kind: "session",
        account: { email: "alice@example.test" },
        device: {
          device_label: "Moosewave Desktop on Windows",
          device_type: "desktop",
        },
        remember: false,
        expires_in: 540,
      },
    });
    renderSection();
    enterCode();
    act(() => button("Review request").click());
    await flush();

    expect(container?.textContent).toContain("incomplete device disclosure");
    expect(container?.textContent).not.toContain("Approve sign-in");
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.deny).not.toHaveBeenCalled();
  });

  it("uses only the consent proof from the latest review", async () => {
    const disclosure = {
      grant_kind: "session",
      account: {
        email: "approved-account@example.test",
        workspace_name: "Approved Workspace",
      },
      device: {
        device_label: "Moosewave Desktop on Windows",
        device_type: "desktop",
        device_os: "Windows",
      },
      remember: false,
      expires_in: 540,
    };
    mocks.inspect
      .mockResolvedValueOnce({
        data: { ...disclosure, consent_token: "first-consent-proof" },
      })
      .mockResolvedValueOnce({
        data: { ...disclosure, consent_token: "replacement-consent-proof" },
      });
    mocks.approve
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          status: 400,
          code: "consent_required",
          message: "review again",
        },
      })
      .mockResolvedValueOnce({ data: { ...disclosure, ok: true } });
    renderSection();
    enterCode();

    act(() => button("Review request").click());
    await flush();
    act(() => button("Approve sign-in").click());
    await flush();
    expect(mocks.approve).toHaveBeenNthCalledWith(
      1,
      "ABCD-1234",
      "first-consent-proof",
    );
    expect(container?.textContent).toContain("Review the request again");

    act(() => button("Review request").click());
    await flush();
    act(() => button("Approve sign-in").click());
    await flush();
    expect(mocks.approve).toHaveBeenNthCalledWith(
      2,
      "ABCD-1234",
      "replacement-consent-proof",
    );
    expect(container?.textContent).toContain("Device approved");
  });

  it("fails closed when the server omits the account disclosure", async () => {
    mocks.inspect.mockResolvedValue({
      data: {
        grant_kind: "session",
        device: {
          device_label: "Moosewave Desktop on Windows",
          device_type: "desktop",
        },
        remember: false,
        expires_in: 540,
      },
    });
    renderSection();
    enterCode();
    act(() => button("Review request").click());
    await flush();

    expect(container?.textContent).toContain("incomplete device disclosure");
    expect(container?.textContent).not.toContain("Approve sign-in");
  });

  it("does not offer approval without a cookie-backed account", () => {
    renderSection(null);
    expect(container?.textContent).toContain(
      "Sign in with an account session to approve another device.",
    );
    expect(container?.querySelector("input")).toBeNull();
  });
});
