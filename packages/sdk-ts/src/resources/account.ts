import { Resource } from "./_base.js";
import type { MeResponse } from "../types.js";

/**
 * Tenant sending-identity / workspace defaults, as persisted by
 * `workspace_settings` and exposed at `/api/v1/settings/workspace`.
 *
 * NOTE: the backend does NOT expose a `PATCH /api/v1/me` route (that path
 * is GET-only — it echoes the resolved tenant/user). The mutable
 * per-tenant from-identity lives on the workspace-settings surface:
 * `display_name` is the outbound display ("from") name and
 * `default_reply_to` is the default reply-to address. A verified sending
 * DOMAIN is managed separately via the DKIM wizard
 * (`/api/v1/sending-identities`), not as a single mutable field here.
 */
export interface AccountUpdateInput {
  /** Outbound display ("from") name, e.g. "Acme Team". */
  display_name?: string;
  /** Default reply-to address for outbound mail. */
  default_reply_to?: string;
}

/** Projection returned by GET/PATCH /api/v1/settings/workspace. */
export interface WorkspaceSettings {
  tenant_id: string;
  display_name?: string;
  default_reply_to?: string;
  timezone: string;
  date_format: string;
  brand_color?: string;
  logo_url?: string;
  updated_by_user_id?: string;
  updated_at: string;
}

export const ACCOUNT_DELETION_CONFIRMATION = "DELETE MY ACCOUNT" as const;

/** Input for deleting the authenticated session user, never the tenant. */
export interface DeleteOwnAccountInput {
  confirmation: typeof ACCOUNT_DELETION_CONFIRMATION;
  /** Required when the current session's authentication method is password. */
  password?: string;
  /** Required when the user has confirmed TOTP enrollment. */
  mfa_code?: string;
  region?: "GDPR" | "CCPA" | "LGPD" | "OTHER";
}

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

export interface AccountDeletionStatusResponse {
  request: AccountDeletionRequest | null;
  replayed?: boolean;
  scope?: AccountDeletionDisclosure;
}

export class AccountResource extends Resource {
  me(): Promise<MeResponse> {
    return this.client.request("GET", "/api/v1/me");
  }

  update(input: AccountUpdateInput): Promise<WorkspaceSettings> {
    return this.client.request("PATCH", "/api/v1/settings/workspace", {
      body: input,
    });
  }

  /**
   * Queue deletion of only the authenticated user. This endpoint rejects API
   * keys; construct PostwaveClient with authMode="session" and credentials
   * appropriate to the host (normally "include"). Last owners must transfer
   * ownership before calling it.
   */
  deleteSelf(
    input: DeleteOwnAccountInput,
    idempotencyKey?: string,
  ): Promise<AccountDeletionResponse> {
    return this.client.request("DELETE", "/api/v1/account", {
      body: input,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  /** Read only the authenticated user's deletion request status. */
  deletionStatus(): Promise<AccountDeletionStatusResponse> {
    return this.client.request("GET", "/api/v1/account/deletion");
  }
}
