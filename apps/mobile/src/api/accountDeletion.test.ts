import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_DELETION_CONFIRMATION,
  buildAccountDeletionInput,
  canSubmitAccountDeletion,
  deleteOwnAccount,
} from "./accountDeletion";
import { getClient } from "./client";

vi.mock("./client", () => ({ getClient: vi.fn() }));

describe("mobile self account deletion", () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset().mockResolvedValue({
      request: { request_id: "prv-1", status: "queued" },
      replayed: false,
      scope: {},
    });
    vi.mocked(getClient).mockReturnValue({ client: { request } } as never);
  });

  it("requires the exact phrase, current password, and enrolled MFA code", () => {
    expect(
      canSubmitAccountDeletion({
        confirmation: "DELETE",
        authProvider: "password",
        password: "current",
        hasTotp: true,
        mfaCode: "123456",
      }),
    ).toBe(false);
    expect(
      canSubmitAccountDeletion({
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
        authProvider: "password",
        password: "current",
        hasTotp: true,
        mfaCode: "123456",
      }),
    ).toBe(true);
  });

  it("does not invent a password field for provider reauthentication", () => {
    expect(
      buildAccountDeletionInput({
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
        authProvider: "google",
        password: "",
        hasTotp: false,
        mfaCode: "",
      }),
    ).toEqual({ confirmation: "DELETE MY ACCOUNT", region: "OTHER" });
  });

  it("calls the dedicated session-only DELETE route with a stable retry key", async () => {
    const input = buildAccountDeletionInput({
      confirmation: ACCOUNT_DELETION_CONFIRMATION,
      authProvider: "password",
      password: "current password",
      hasTotp: true,
      mfaCode: "123456",
    });
    await deleteOwnAccount(input, "mobile-retry-1");
    expect(request).toHaveBeenCalledWith("DELETE", "/api/v1/account", {
      body: {
        confirmation: "DELETE MY ACCOUNT",
        password: "current password",
        mfa_code: "123456",
        region: "OTHER",
      },
      idempotencyKey: "mobile-retry-1",
    });
  });
});
