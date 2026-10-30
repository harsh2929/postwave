// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { qk } from "@/lib/query-keys";

/**
 * Per-route actionable count badges for the sidebar (SHELL-023). Currently
 * wires the pending-Approvals queue; the return shape is a plain href→count map
 * so more queues can be folded in without touching the nav renderer.
 *
 * The approval count remains a best-effort plain poll, while the live auth
 * query is observed so a cached authority downgrade immediately tears the poll
 * down. A viewer who cannot list approvals or an offline tab simply sees no
 * badge. The poll is re-keyed on the exact user, tenant, effective role, and
 * viewer-mode state so a count never crosses authority.
 */
export function useNavBadges(
  identity: MeResponse | null,
): Record<string, number> {
  const [pending, setPending] = useState(0);
  // QueryProvider seeds this entry. Observing it directly makes a fresh
  // authority downgrade take effect even when DashboardShell's server prop has
  // not changed and prevents a removed auth entry from falling back to it.
  const liveIdentityQuery = useQuery<MeResponse | null>({
    queryKey: qk.authMe(),
    queryFn: async () => null,
    enabled: false,
    initialData: identity,
  });
  const liveIdentity = liveIdentityQuery.data ?? null;
  const effectiveRole = liveIdentity ? effectiveAuthRole(liveIdentity) : null;
  const canReview = Boolean(
    liveIdentity &&
    !liveIdentity.viewer_mode &&
    (effectiveRole === "owner" || effectiveRole === "admin"),
  );
  const authorityKey = liveIdentity
    ? [
        liveIdentity.tenant_id,
        liveIdentity.user_id,
        effectiveRole,
        liveIdentity.viewer_mode ? "viewer-mode" : "member-mode",
      ].join("\u001f")
    : "unverified";
  const tenantId = liveIdentity?.tenant_id ?? null;

  useEffect(() => {
    setPending(0);
    if (!canReview || !tenantId) {
      return;
    }
    let alive = true;
    let latestLoad = 0;
    const controller = new AbortController();
    const load = (): void => {
      const loadNumber = ++latestLoad;
      try {
        // Badge polling starts after hydration and is best-effort. Defer its
        // API surface so routes do not pay for approval operations merely to
        // render the navigation rail.
        void import("@/lib/approvals-api")
          .then(({ isActionable, listApprovals }) =>
            listApprovals("pending", 100, {
              expectedTenantId: tenantId,
              signal: controller.signal,
            }).then((items) => items.filter((item) => isActionable(item))),
          )
          .then((items) => {
            if (alive && loadNumber === latestLoad) setPending(items.length);
          })
          .catch(() => {
            if (alive && loadNumber === latestLoad) setPending(0);
          });
      } catch {
        /* synchronous failure (e.g. no fetch in a test env) — ignore */
      }
    };
    load();
    const id = window.setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(id);
    };
  }, [authorityKey, canReview, tenantId]);

  return canReview && pending > 0 ? { "/app/approvals": pending } : {};
}
