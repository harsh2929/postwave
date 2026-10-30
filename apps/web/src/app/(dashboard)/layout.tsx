// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ApiError } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import { PATHNAME_HEADER, safeNextPath } from "@/lib/safe-navigation";

import { DashboardShell } from "./dashboard-shell";

// Dashboard routes read tenant-specific runtime data. Do not prerender them
// during `next build`; production runtime should fail loudly if the API is
// unavailable instead of silently substituting mock data.
export const dynamic = "force-dynamic";

/**
 * Where to send the visitor back to after they re-authenticate.
 *
 * These three redirects used to hardcode `?next=%2Fapp`. The middleware already
 * computes and preserves the real destination for the no-session case, so a
 * visitor with no cookie landed back where they started — but a visitor whose
 * session expired mid-use took this path instead (cookie present, API says
 * 401), and was silently returned to the dashboard root. The deeper the page,
 * the worse it read: an emailed link to one campaign's analytics became "here
 * is your dashboard, find it yourself".
 *
 * The forwarded header is a hint, not a trusted value; `safeNextPath` is what
 * makes it safe to redirect to, and it falls back to `/app` on anything it
 * does not recognise.
 */
async function returnTo(): Promise<string> {
  const requested = (await headers()).get(PATHNAME_HEADER);
  return encodeURIComponent(safeNextPath(requested));
}

/**
 * The script nonce middleware minted for this document (src/middleware.ts,
 * nextWithStrictCSP). The theme provider's pre-paint script needs it: without
 * a nonce the browser blocks it under the dashboard's strict policy, and a
 * dark-theme user sees the light theme flash first on every load.
 */
async function requestNonce(): Promise<string | undefined> {
  return (await headers()).get("x-nonce") ?? undefined;
}

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  try {
    const me = await whoami();
    if (me.mfa_required && !me.mfa_satisfied) {
      redirect(`/totp-challenge?next=${await returnTo()}`);
    }
    return (
      <DashboardShell initialMe={me} nonce={await requestNonce()}>
        {children}
      </DashboardShell>
    );
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.status === 403 &&
      err.code === "mfa_required"
    ) {
      redirect(`/totp-challenge?next=${await returnTo()}`);
    }
    if (err instanceof ApiError && err.status === 401) {
      redirect(`/login?next=${await returnTo()}`);
    }
    throw err;
  }
}
