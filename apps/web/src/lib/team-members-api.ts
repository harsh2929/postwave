// SPDX-License-Identifier: AGPL-3.0-only
//
// SETC-010 — the workspace roster + copy-link invitations. Typed wrappers over
// the /api/v1/workspace/members and /api/v1/workspace/invites surfaces
// (apps/api/internal/handlers/workspace_members.go + workspace_invites.go).

import { api } from "@/lib/api";
import type { AuthRole } from "@/lib/auth-api";

export interface TeamRequestOptions {
  signal?: AbortSignal;
  requireOnline?: boolean;
  maxAttempts?: number;
  idempotencyKey?: string | null;
}

export interface WorkspaceMember {
  id: string;
  email: string;
  role: AuthRole;
  /** active | suspended | deleted (deleted is owned by account-deletion). */
  status: string;
  authProvider: string;
  emailVerified: boolean;
  effectiveScopes: string[];
  /** True for the calling session's own row — controls are disabled on it. */
  isSelf: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MembersResponse {
  members: WorkspaceMember[];
  total: number;
  limit: number;
  offset: number;
  assignableRoles: string[];
  assignableStatus: string[];
  /** Whether the caller may grant the owner role (owner-only). */
  callerIsOwner: boolean;
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: AuthRole;
  createdAt: string;
  expiresAt: string;
}

export interface CreateInviteResponse {
  invite: WorkspaceInvite;
  /** One-time token; compose the accept link with acceptInviteUrl(). */
  token: string;
}

export function listMembers(
  options?: TeamRequestOptions,
): Promise<MembersResponse> {
  return api.get<MembersResponse>("/api/v1/workspace/members", options);
}

/** Change a member's role and/or lifecycle status (suspend = remove access). */
export function patchMember(
  id: string,
  patch: { role?: string; status?: string },
  options?: TeamRequestOptions,
): Promise<{ member: WorkspaceMember }> {
  return api.patch<{ member: WorkspaceMember }>(
    `/api/v1/workspace/members/${encodeURIComponent(id)}`,
    patch,
    options,
  );
}

export function createInvite(
  email: string,
  role: string,
  options?: TeamRequestOptions,
): Promise<CreateInviteResponse> {
  return api.post<CreateInviteResponse>(
    "/api/v1/workspace/invites",
    {
      email,
      role,
    },
    options,
  );
}

export function listInvites(
  options?: TeamRequestOptions,
): Promise<{ invites: WorkspaceInvite[] }> {
  return api.get<{ invites: WorkspaceInvite[] }>(
    "/api/v1/workspace/invites",
    options,
  );
}

export function revokeInvite(
  id: string,
  options?: TeamRequestOptions,
): Promise<{ ok: boolean }> {
  return api.delete<{ ok: boolean }>(
    `/api/v1/workspace/invites/${encodeURIComponent(id)}`,
    options,
  );
}

// --- Pure helpers (unit-testable) ----------------------------------------

export const MEMBER_ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

export function labelForMemberRole(role: string): string {
  return MEMBER_ROLE_LABELS[role] ?? role;
}

const MEMBER_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  suspended: "Suspended",
  deleted: "Deleted",
};

export function labelForMemberStatus(status: string): string {
  return MEMBER_STATUS_LABELS[status] ?? status;
}

/**
 * Compose the copy-link accept URL from the one-time token. The invitee opens
 * it, sets a password, and joins the workspace with the invited role.
 */
export function acceptInviteUrl(origin: string, token: string): string {
  return `${origin}/accept-invite?token=${encodeURIComponent(token)}`;
}

/**
 * The role Select must never offer "owner" to a caller who can't grant it, and
 * an admin can't re-role an owner. Returns the assignable role options for a
 * given target row + caller.
 */
export function assignableRoleOptions(
  callerIsOwner: boolean,
  targetRole: string,
): AuthRole[] {
  const all: AuthRole[] = ["owner", "admin", "editor", "viewer"];
  if (callerIsOwner) return all;
  // A non-owner cannot grant owner, nor modify a sitting owner at all.
  if (targetRole === "owner") return ["owner"];
  return all.filter((r) => r !== "owner");
}
