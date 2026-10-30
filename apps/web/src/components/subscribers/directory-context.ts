// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Shared plumbing for the directory toolbar pieces: the caller's identity
// (read the way the subscribers page reads it) and the directory's URL state.
//
// The subscribers page keeps its list state in the URL (`useTableUrlState`
// with page/q/status/sort/order/archived). These controls read and write the
// SAME params with the same codecs, so a chip, sort, saved view or reset made
// here is the page's own state: the page re-derives from the URL and refetches
// with it, and Back/Forward/deep links keep working.

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  SUBSCRIBER_SORT_KEYS,
  SUBSCRIBER_STATUS_FILTERS,
} from "@/app/(dashboard)/app/subscribers/subscribers-list-helpers";
import { effectiveAuthRole, whoami, type AuthRole } from "@/lib/auth-api";
import { base, qk, STALE } from "@/lib/query-keys";
import {
  subscriberAuthorityFromMe,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  DEFAULT_DIRECTORY_VIEW,
  type DirectoryView,
} from "@/lib/subscriber-directory-api";
import { enumParam, intParam, stringParam } from "@/lib/table-url-state";
import { useTableUrlState } from "@/lib/use-table-url-state";

export const DIRECTORY_URL_SCHEMA = {
  page: intParam(1),
  q: stringParam(""),
  status: enumParam(SUBSCRIBER_STATUS_FILTERS, "all"),
  sort: enumParam(SUBSCRIBER_SORT_KEYS, "updated_at"),
  order: enumParam(["asc", "desc"] as const, "desc"),
  archived: enumParam(["0", "1"] as const, "0"),
} as const;

export function sameDirectoryView(a: DirectoryView, b: DirectoryView): boolean {
  return (
    a.q.trim() === b.q.trim() &&
    a.status === b.status &&
    a.archived === b.archived &&
    a.sort === b.sort &&
    a.order === b.order
  );
}

export function useDirectoryUrlState() {
  const { state, setState, reset } = useTableUrlState(DIRECTORY_URL_SCHEMA);
  const view = useMemo<DirectoryView>(
    () => ({
      q: state.q,
      status: state.status,
      archived: state.archived === "1",
      sort: state.sort,
      order: state.order,
    }),
    [state.archived, state.order, state.q, state.sort, state.status],
  );
  const applyView = useCallback(
    (next: DirectoryView) =>
      setState({
        q: next.q.trim(),
        status: next.status,
        archived: next.archived ? "1" : "0",
        sort: next.sort,
        order: next.order,
        page: 1,
      }),
    [setState],
  );
  const isDefault =
    state.page === 1 && sameDirectoryView(view, DEFAULT_DIRECTORY_VIEW);
  return { view, page: state.page, setState, applyView, reset, isDefault };
}

export interface DirectoryIdentity {
  ready: boolean;
  tenantId: string;
  userId: string;
  role: AuthRole | null;
  authority: SubscriberAuthority | null;
  /** owner / admin / editor — `write:subscribers`. */
  canWrite: boolean;
  /** owner / admin — the `admin` scope bulk verbs and imports require. */
  canAdmin: boolean;
  /** Tenant/role-scoped prefix every subscribers-list query lives under. */
  subscribersKey: readonly unknown[];
}

export function useDirectoryIdentity(): DirectoryIdentity {
  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const role = me.data ? effectiveAuthRole(me.data) : null;
  const authority = me.data ? subscriberAuthorityFromMe(me.data) : null;
  return {
    ready: me.isSuccess,
    tenantId,
    userId: me.data?.user_id ?? "",
    role,
    authority,
    canWrite: Boolean(authority),
    canAdmin: authority?.role === "owner" || authority?.role === "admin",
    subscribersKey: base("subscribers", tenantId, role),
  };
}
