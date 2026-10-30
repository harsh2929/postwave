// SPDX-License-Identifier: AGPL-3.0-only
//
// Privacy retention policy client. Backend:
// apps/api/internal/settings/privacy.go.

import { api } from "./api";

export interface RetentionPolicy {
  tenant_id: string;
  audit_log_retention_days: number;
  email_event_retention_days: number;
  unsubscribed_subscriber_retention_days: number;
  updated_by_user_id?: string | null;
  updated_at?: string;
}

export interface RetentionPolicyPatch {
  audit_log_retention_days?: number;
  email_event_retention_days?: number;
  unsubscribed_subscriber_retention_days?: number;
}

export const retentionPolicyApi = {
  get: (signal?: AbortSignal) =>
    api.get<RetentionPolicy>("/api/v1/settings/privacy", { signal }),
  patch: (patch: RetentionPolicyPatch, signal?: AbortSignal) =>
    api.patch<RetentionPolicy>("/api/v1/settings/privacy", patch, { signal }),
};
