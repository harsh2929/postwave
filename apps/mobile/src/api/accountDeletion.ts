import { getClient } from "./client";

export const ACCOUNT_DELETION_CONFIRMATION = "DELETE MY ACCOUNT" as const;

export type AccountDeletionRegion = "GDPR" | "CCPA" | "LGPD" | "OTHER";

export type DeleteOwnAccountInput = {
  confirmation: typeof ACCOUNT_DELETION_CONFIRMATION;
  password?: string;
  mfa_code?: string;
  region: AccountDeletionRegion;
};

export type AccountDeletionResponse = {
  request: {
    request_id: string;
    status: string;
    requested_at: string;
    execute_after: string;
    due_at: string;
    legal_hold: boolean;
    retention_expires_at: string;
  };
  replayed: boolean;
  scope: {
    deletes: string[];
    keeps: string[];
    legal_hold_may_delay: boolean;
    backup_expiry_policy: string;
    certificate_retained_until: string;
  };
};

export function canSubmitAccountDeletion(input: {
  confirmation: string;
  authProvider: string;
  password: string;
  hasTotp: boolean;
  mfaCode: string;
}): boolean {
  return (
    input.confirmation === ACCOUNT_DELETION_CONFIRMATION &&
    (input.authProvider !== "password" || input.password.length > 0) &&
    (!input.hasTotp || /^\d{6}$/.test(input.mfaCode))
  );
}

export function buildAccountDeletionInput(input: {
  confirmation: string;
  authProvider: string;
  password: string;
  hasTotp: boolean;
  mfaCode: string;
}): DeleteOwnAccountInput {
  if (!canSubmitAccountDeletion(input)) {
    throw new Error("Account deletion confirmation is incomplete.");
  }
  return {
    confirmation: ACCOUNT_DELETION_CONFIRMATION,
    ...(input.authProvider === "password" ? { password: input.password } : {}),
    ...(input.hasTotp ? { mfa_code: input.mfaCode } : {}),
    region: "OTHER",
  };
}

export async function deleteOwnAccount(
  input: DeleteOwnAccountInput,
  idempotencyKey: string = newDeletionIdempotencyKey(),
): Promise<AccountDeletionResponse> {
  const { client } = getClient();
  return client.request<AccountDeletionResponse>("DELETE", "/api/v1/account", {
    body: input,
    idempotencyKey,
  });
}

export function accountDeletionErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : "";
}

function newDeletionIdempotencyKey(): string {
  // This key is a retry correlation value, not an authentication secret. The
  // SDK sends it only over the configured HTTPS API origin.
  return `mobile-account-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
