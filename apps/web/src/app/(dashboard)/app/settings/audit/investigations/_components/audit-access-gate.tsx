// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  canReadRawAudit,
  getAuditCapabilities,
  type AuditCapabilities,
} from "@/lib/audit-saved-views-access-api";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { base, qk, STALE } from "@/lib/query-keys";

const AuditRestrictedAccessPanel = dynamic(
  () =>
    import("@/components/settings/audit-views-access-panels").then(
      (module) => module.AuditRestrictedAccessPanel,
    ),
  {
    ssr: false,
    loading: () => (
      <p role="status" className="text-sm text-muted-foreground">
        Loading audit-access controls…
      </p>
    ),
  },
);

export interface AuditAccess {
  identity: MeResponse;
  capabilities: AuditCapabilities;
  tenantId: string;
  /** Cache-key role — the session downgrade when viewer mode is on. */
  roleKey: string;
}

/**
 * The same door the audit log page stands behind: identity, then the
 * server's statement of this caller's audit scopes, and the restricted-access
 * panel when raw audit (audit:read + audit:read_pii) is not among them.
 * Investigations cite raw audit rows, so the gate is the raw-audit gate — the
 * server enforces it on every investigation route (`gates.raw`), and this is
 * what keeps a viewer from opening a page that would only 403 at it.
 */
export function AuditAccessGate({
  title,
  children,
}: {
  title: string;
  children: (access: AuditAccess) => ReactNode;
}) {
  const identityQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = identityQuery.data;
  const roleKey = identity ? effectiveAuthRole(identity) : null;
  const capabilitiesQuery = useQuery({
    queryKey: [
      ...base("audit-capabilities", identity?.tenant_id ?? "", roleKey),
      Boolean(identity?.viewer_mode),
    ],
    queryFn: ({ signal }) => getAuditCapabilities(signal),
    enabled: Boolean(identity),
    retry: false,
  });

  if (
    !identityQuery.isError &&
    !capabilitiesQuery.isError &&
    (identityQuery.isPending || capabilitiesQuery.isPending)
  ) {
    return (
      <div className="max-w-3xl space-y-4" role="status">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <span className="sr-only">Checking audit access…</span>
      </div>
    );
  }

  const capabilities = capabilitiesQuery.data;
  if (
    identityQuery.isError ||
    capabilitiesQuery.isError ||
    !identity ||
    !capabilities ||
    !roleKey
  ) {
    const error = identityQuery.error ?? capabilitiesQuery.error;
    return (
      <div className="max-w-3xl space-y-4">
        <header>
          <h2 className="font-display text-xl font-semibold tracking-tight">
            {title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Audit access could not be verified.
          </p>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>Access check failed</CardTitle>
            <CardDescription>
              {error instanceof Error
                ? error.message
                : "The audit-capability request failed."}{" "}
              No investigation was displayed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              onClick={() => {
                void identityQuery.refetch();
                void capabilitiesQuery.refetch();
              }}
            >
              Retry access check
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!canReadRawAudit(capabilities)) {
    return <AuditRestrictedAccessPanel identity={identity} />;
  }

  return (
    <>
      {children({
        identity,
        capabilities,
        tenantId: identity.tenant_id,
        roleKey,
      })}
    </>
  );
}
