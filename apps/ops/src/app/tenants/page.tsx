// SPDX-License-Identifier: AGPL-3.0-only
//
// The cross-tenant directory is an anchor of the ops console. A non-OK fetch
// is a full-page loud error, never an empty table (mirrors board/page.tsx: an
// empty ops surface reads as all-clear).
import {
  TenantDirectory,
  TenantDirectoryError,
} from "@/components/TenantDirectory";
import { fetchTenants } from "@/lib/tenants";

export const dynamic = "force-dynamic";

interface TenantsPageProps {
  searchParams?: Promise<{ search?: string | string[] }>;
}

export default async function TenantsPage({ searchParams }: TenantsPageProps) {
  const parameters = searchParams ? await searchParams : {};
  const rawSearch = Array.isArray(parameters.search)
    ? parameters.search[0]
    : parameters.search;
  const search = rawSearch?.trim() ?? "";
  const result = await fetchTenants(search);

  if (!result.ok) {
    return <TenantDirectoryError message={result.message} />;
  }

  return (
    <TenantDirectory
      search={search}
      tenants={result.tenants}
      truncated={result.truncated}
    />
  );
}
