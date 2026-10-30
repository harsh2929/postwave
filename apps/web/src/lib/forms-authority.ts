// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";

export type FormAuthorityLevel = "write" | "admin";

const FORM_WRITE_ROLES: readonly AuthRole[] = ["owner", "admin", "editor"];
const FORM_ADMIN_ROLES: readonly AuthRole[] = ["owner", "admin"];

export const FORM_READ_ONLY_MESSAGE =
  "Forms are read-only for this session. Owner, admin, or editor access outside viewer mode is required to change form configuration.";

export const FORM_ADMIN_ONLY_MESSAGE =
  "Submission data and destructive form actions are restricted to owners and admins outside viewer mode.";

export class FormAuthorityError extends Error {
  readonly code = "form_authority_changed";

  constructor(level: FormAuthorityLevel) {
    super(
      level === "admin"
        ? "Your owner or admin authority changed while this action was open. Nothing was changed; refresh the page and review your current access before trying again."
        : "Your form write authority changed while this action was open. Nothing was changed; refresh the page and review your current access before trying again.",
    );
    this.name = "FormAuthorityError";
  }
}

export function canWriteForms(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    FORM_WRITE_ROLES.includes(effectiveAuthRole(identity)),
  );
}

export function canAdminForms(
  identity: MeResponse | null | undefined,
): boolean {
  return Boolean(
    identity &&
    identity.viewer_mode !== true &&
    FORM_ADMIN_ROLES.includes(effectiveAuthRole(identity)),
  );
}

export function assertFreshFormAuthority(
  opened: MeResponse | null | undefined,
  fresh: MeResponse,
  level: FormAuthorityLevel,
): void {
  const permitted = level === "admin" ? canAdminForms : canWriteForms;
  if (
    !opened ||
    opened.user_id !== fresh.user_id ||
    opened.tenant_id !== fresh.tenant_id ||
    effectiveAuthRole(opened) !== effectiveAuthRole(fresh) ||
    Boolean(opened.viewer_mode) !== Boolean(fresh.viewer_mode) ||
    !permitted(opened) ||
    !permitted(fresh)
  ) {
    throw new FormAuthorityError(level);
  }
}
