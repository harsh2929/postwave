// SPDX-License-Identifier: AGPL-3.0-only

const CUSTOMERIO_WORKSPACE_ID_RE = /^\d{1,64}$/u;

export function customerIOWorkspaceIDError(value: string): string | null {
  const workspaceID = value.trim();
  if (!workspaceID) return null;
  if (!CUSTOMERIO_WORKSPACE_ID_RE.test(workspaceID)) {
    return "Customer.io workspace ID must contain 1 to 64 digits.";
  }
  return null;
}
