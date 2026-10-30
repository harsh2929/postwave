// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "./api";
import type { PrivacyRegion } from "./privacy-api";

export const ACCOUNT_DELETION_CONFIRMATION = "DELETE MY ACCOUNT" as const;

export interface AccountDeletionRequest {
  request_id: string;
  status:
    | "queued"
    | "verifying"
    | "in_progress"
    | "blocked_legal_hold"
    | "blocked_ownership"
    | "fulfilled";
  requested_at: string;
  execute_after: string;
  due_at: string;
  completed_at?: string;
  legal_hold: boolean;
  retention_expires_at: string;
}

export interface AccountDeletionDisclosure {
  deletes: string[];
  keeps: string[];
  legal_hold_may_delay: boolean;
  backup_expiry_policy: string;
  certificate_retained_until: string;
}

export interface AccountDeletionResponse {
  request: AccountDeletionRequest;
  replayed: boolean;
  scope: AccountDeletionDisclosure;
}

export interface DeleteOwnAccountInput {
  confirmation: typeof ACCOUNT_DELETION_CONFIRMATION;
  password?: string;
  mfa_code?: string;
  region?: PrivacyRegion;
}

export function deleteOwnAccount(
  input: DeleteOwnAccountInput,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<AccountDeletionResponse> {
  return api.delete<AccountDeletionResponse>("/api/v1/account", {
    body: input,
    headers: { "Idempotency-Key": idempotencyKey },
    requireOnline: true,
    maxAttempts: 0,
  });
}

export function accountDeletionStatus(): Promise<{
  request: AccountDeletionRequest | null;
  replayed?: boolean;
  scope?: AccountDeletionDisclosure;
}> {
  return api.get("/api/v1/account/deletion", { requireOnline: true });
}
