// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import SecuritySettingsPage from "@/app/(dashboard)/app/settings/security/page";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  totpEnroll: vi.fn(),
  totpVerify: vi.fn(),
  totpDisable: vi.fn(),
  getSecuritySettings: vi.fn(),
  updateSecuritySettings: vi.fn(),
  listScimTokens: vi.fn(),
  mintScimToken: vi.fn(),
  revokeScimToken: vi.fn(),
  listRoleMappings: vi.fn(),
  upsertRoleMapping: vi.fn(),
  deleteRoleMapping: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  verifyFreshAdminAuthority: vi.fn(),
}));

// This test owns SCIM query/refetch behaviour, not Next's loader. Mount the
// fifth dynamic boundary (ScimAdminSection in page declaration order) and
// leave the unrelated deferred cards out of this focused harness.
vi.mock("next/dynamic", async () => {
  const { ScimAdminSection } =
    await import("@/app/(dashboard)/app/settings/security/scim-admin-section");
  let nextBoundary = 0;

  return {
    default: () => {
      const boundary = nextBoundary;
      nextBoundary += 1;
      return boundary === 4 ? ScimAdminSection : () => null;
    },
  };
});

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  totpEnroll: mocks.totpEnroll,
  totpVerify: mocks.totpVerify,
  totpDisable: mocks.totpDisable,
  totpChallenge: async () => ({ mfa_satisfied: true }),
  // SETC-035: the TOTP card reads recovery-code status while 2FA is active.
  getRecoveryCodesStatus: async () => ({
    enrolled: false,
    remaining: 0,
    total: 8,
    low: false,
  }),
  regenerateRecoveryCodes: async () => ({
    recovery_codes: [],
    remaining: 8,
    total: 8,
  }),
  oauthLinkStartUrl: (provider: string) =>
    `/api/v1/auth/oauth/${provider}/start?redirect_to=%2Fapp%2Fsettings%2Fsecurity&link=true`,
  // SETC-021: IdentityProviderCard now reads linked identities.
  listOAuthIdentities: async () => ({
    identities: [],
    has_password: true,
    has_passkey: false,
  }),
  unlinkOAuthIdentity: async () => undefined,
  // AUTH-023: PasskeysCard also mounts on this page. jsdom has no WebAuthn, so
  // passkeySupported() is false and the card renders null — but its imports
  // must still resolve on the mock.
  passkeySupported: () => false,
  listPasskeys: async () => [],
  registerPasskey: async () => ({}),
  renamePasskey: async () => ({ ok: true, name: "" }),
  deletePasskey: async () => ({ ok: true }),
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyFreshAdminAuthority,
}));

vi.mock("@/lib/security-api", () => ({
  getSecuritySettings: mocks.getSecuritySettings,
  updateSecuritySettings: mocks.updateSecuritySettings,
}));

vi.mock("@/lib/scim-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scim-api")>();
  return {
    ...actual,
    listScimTokens: mocks.listScimTokens,
    mintScimToken: mocks.mintScimToken,
    revokeScimToken: mocks.revokeScimToken,
    listRoleMappings: mocks.listRoleMappings,
    upsertRoleMapping: mocks.upsertRoleMapping,
    deleteRoleMapping: mocks.deleteRoleMapping,
  };
});

vi.mock("@/lib/audit-api", () => ({
  listAuditLog: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): { root: Root } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return { root };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

function primeAuth(): void {
  mocks.whoami.mockResolvedValue({
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "ada@example.com",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
    mfa_satisfied: false,
  });
}

function primeSecurityQueries(): void {
  mocks.getSecuritySettings.mockResolvedValue({
    require_2fa_for_admins: true,
    require_2fa_for_all: false,
    sso_provider: "okta",
    sso_metadata_url: "",
    session_max_minutes: 60,
  });
  mocks.listScimTokens.mockResolvedValue([
    {
      id: "tok_1",
      prefix: "pst_live",
      description: "Okta production",
      created_at: "2026-06-28T00:00:00.000Z",
      revoked_at: null,
    },
  ]);
  mocks.listRoleMappings.mockResolvedValue([
    {
      id: "map_1",
      group_name: "Marketing",
      role: "editor",
      precedence: 10,
      created_at: "2026-06-28T00:00:00.000Z",
    },
  ]);
}

function findButton(name: string, occurrence = 0): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button")).filter(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.trim() === name,
  );
  const button = buttons[occurrence];
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

describe("SecuritySettingsPage query freshness", () => {
  it("does not request admin security data in viewer mode", async () => {
    primeAuth();
    mocks.whoami.mockResolvedValueOnce({
      user_id: "usr_1",
      tenant_id: "tnt_1",
      email: "ada@example.com",
      role: "admin",
      effective_role: "admin",
      viewer_mode: true,
    });
    const { root } = render(<SecuritySettingsPage />);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "require an owner or administrator",
        ),
      );
      expect(mocks.getSecuritySettings).not.toHaveBeenCalled();
      expect(mocks.listScimTokens).not.toHaveBeenCalled();
      expect(mocks.listRoleMappings).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not request admin security data after an identity error", async () => {
    mocks.whoami.mockRejectedValue(new Error("Session verification failed."));
    const { root } = render(<SecuritySettingsPage />);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "access could not be verified",
        ),
      );
      expect(mocks.getSecuritySettings).not.toHaveBeenCalled();
      expect(mocks.listScimTokens).not.toHaveBeenCalled();
      expect(mocks.listRoleMappings).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("loads enforced security settings and SCIM tokens through queries", async () => {
    primeAuth();
    primeSecurityQueries();

    const { root } = render(createElement(SecuritySettingsPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Okta production");
        // SETC-011: the role-mapping admin now renders on the Security tab.
        expect(document.body.textContent).toContain("SCIM group");
      });
      expect(mocks.getSecuritySettings).toHaveBeenCalledTimes(1);
      expect(mocks.listScimTokens).toHaveBeenCalledTimes(1);
      expect(mocks.listRoleMappings).toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("refetches SCIM tokens after a token is revoked", async () => {
    primeAuth();
    primeSecurityQueries();
    mocks.listScimTokens
      .mockResolvedValueOnce([
        {
          id: "tok_1",
          prefix: "pst_live",
          description: "Okta production",
          created_at: "2026-06-28T00:00:00.000Z",
          revoked_at: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "tok_1",
          prefix: "pst_live",
          description: "Okta production",
          created_at: "2026-06-28T00:00:00.000Z",
          revoked_at: "2026-06-28T01:00:00.000Z",
        },
      ]);
    mocks.revokeScimToken.mockResolvedValue(undefined);

    const { root } = render(createElement(SecuritySettingsPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Okta production");
      });

      await act(async () => {
        findButton("Revoke").click();
        await flush();
      });

      await act(async () => {
        findButton("Revoke", 1).click();
        await flush();
      });

      await waitFor(() => {
        expect(mocks.revokeScimToken).toHaveBeenCalledWith(
          "tok_1",
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            idempotencyKey: expect.any(String),
          }),
        );
        expect(mocks.listScimTokens).toHaveBeenCalledTimes(2);
        expect(document.body.textContent).toContain("Revoked");
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
