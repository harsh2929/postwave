// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";

export function SampleDataNotice({ account }: { account: MeResponse | null }) {
  const sample = useQuery({
    queryKey: [
      ...qk.settings(
        account?.tenant_id ?? "anon",
        account ? effectiveAuthRole(account) : null,
        "sample-data",
      ),
      account?.user_id ?? "anon",
      Boolean(account?.viewer_mode),
    ],
    queryFn: () =>
      api.get<{ seeded: boolean }>("/api/v1/onboarding/sample-data"),
    enabled: Boolean(account?.tenant_id && account?.user_id),
    staleTime: STALE.detail,
  });
  if (!sample.data?.seeded) return null;
  return (
    <aside
      aria-label="Sample workspace data"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-warning/25 bg-warning-subtle/50 px-4 py-2 text-sm sm:px-6"
    >
      <p>
        <strong>Sample data loaded.</strong> Example contacts, campaigns and
        activity are synthetic.
      </p>
      <Link
        href="/app/settings/developer"
        className="inline-flex min-h-8 items-center font-medium underline underline-offset-4"
      >
        Manage sample data
      </Link>
    </aside>
  );
}
