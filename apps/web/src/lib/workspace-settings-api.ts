// SPDX-License-Identifier: AGPL-3.0-only
//
// Workspace-level settings client. Backend:
// apps/api/internal/settings/workspace.go.

import { api } from "./api";

export interface WorkspaceSettings {
  tenant_id: string;
  display_name?: string | null;
  default_reply_to?: string | null;
  timezone: string;
  date_format: string;
  brand_color?: string | null;
  logo_url?: string | null;
  updated_by_user_id?: string | null;
  updated_at?: string;
}

export interface WorkspaceSettingsPatch {
  display_name?: string;
  default_reply_to?: string;
  timezone?: string;
  date_format?: string;
  brand_color?: string;
  logo_url?: string;
}

interface WorkspaceSettingsRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

function optionalText(value: unknown, max: number): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.length <= max)
  );
}

export function parseWorkspaceSettings(value: unknown): WorkspaceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workspace-settings response was malformed.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.tenant_id !== "string" ||
    row.tenant_id.length === 0 ||
    row.tenant_id.length > 512 ||
    typeof row.timezone !== "string" ||
    row.timezone.length === 0 ||
    row.timezone.length > 256 ||
    typeof row.date_format !== "string" ||
    row.date_format.length === 0 ||
    row.date_format.length > 64 ||
    !optionalText(row.display_name, 512) ||
    !optionalText(row.default_reply_to, 512) ||
    !optionalText(row.brand_color, 64) ||
    !optionalText(row.logo_url, 8 * 1024) ||
    !optionalText(row.updated_by_user_id, 512) ||
    (row.updated_at !== undefined &&
      (typeof row.updated_at !== "string" ||
        row.updated_at.length > 128 ||
        !Number.isFinite(Date.parse(row.updated_at))))
  ) {
    throw new Error("Workspace-settings response was malformed.");
  }
  return row as unknown as WorkspaceSettings;
}

export const workspaceSettingsApi = {
  async get(options: Pick<WorkspaceSettingsRequestOptions, "signal"> = {}) {
    return parseWorkspaceSettings(
      await api.get<unknown>("/api/v1/settings/workspace", {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
      }),
    );
  },
  async patch(
    patch: WorkspaceSettingsPatch,
    options: WorkspaceSettingsRequestOptions = {},
  ) {
    return parseWorkspaceSettings(
      await api.patch<unknown>("/api/v1/settings/workspace", patch, {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
        idempotencyKey: options.idempotencyKey,
      }),
    );
  },
};
