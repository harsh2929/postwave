// SPDX-License-Identifier: AGPL-3.0-only

import type { AuthRole, MeResponse } from "@/lib/auth-api";

export function canAccessSmsAdminSurface(
  me: Pick<MeResponse, "viewer_mode"> | null,
  effectiveRole: AuthRole | null,
): boolean {
  return (
    me !== null &&
    me?.viewer_mode !== true &&
    (effectiveRole === "owner" || effectiveRole === "admin")
  );
}

export function canonicalSmsTabUrl(currentHref: string, nextTab: string): string {
  const url = new URL(currentHref);
  if (nextTab === "overview") {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", nextTab);
  }
  return url.toString();
}
