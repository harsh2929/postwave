// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Customer-managed encryption keys (BYOK).
 *
 * Two `/api/v1/byok/*` paths desktop reached and web did not.
 *
 * THE TWO PROVIDER LISTS MUST NOT BE CONFLATED. `/providers` returns
 * `supported` (what this build can talk to) alongside `providers` (what this
 * workspace has actually configured). Showing the first as though it were the
 * second tells somebody their data is encrypted under their own key when it is
 * not — the worst available misreading on this screen, and an easy one to make
 * because both arrays live in the same response.
 *
 * With nothing configured, the page says so plainly rather than listing what
 * could be configured and letting the reader infer.
 */

import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudCog, KeyRound, ShieldCheck } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Badge } from "@/components/ui/badge";
import { whoami } from "@/lib/auth-api";
import {
  ADMIN_READ_ONLY_MESSAGE,
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import { getByokProviders, listByokKeys } from "@/lib/byok-api";
import { base, STALE } from "@/lib/query-keys";

function providerLabel(provider: unknown): string {
  if (typeof provider === "string") return provider;
  if (provider && typeof provider === "object") {
    const record = provider as Record<string, unknown>;
    const value = record.name ?? record.provider ?? record.id;
    if (typeof value === "string") return value;
  }
  return "Provider details unavailable";
}

export default function EncryptionKeysPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const canAdmin = meQuery.isSuccess && canReadAdminData(identity);
  const [scopeTenant, scopeUser, scopeRole, scopeViewer] =
    adminReadIdentityParts(identity);
  const keyBase = useMemo(
    () =>
      [
        ...base("byok", scopeTenant, scopeRole),
        scopeUser,
        scopeViewer,
      ] as const,
    [scopeRole, scopeTenant, scopeUser, scopeViewer],
  );
  const previousKeyRef = useRef<readonly unknown[] | null>(null);

  const keys = useQuery({
    queryKey: [...keyBase, "keys"],
    queryFn: listByokKeys,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.reference,
  });
  const providers = useQuery({
    queryKey: [...keyBase, "providers"],
    queryFn: getByokProviders,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.reference,
  });

  const keyRows = Array.isArray(keys.data) ? keys.data : [];
  const configured = Array.isArray(providers.data?.providers)
    ? providers.data.providers
    : [];
  const supported = Array.isArray(providers.data?.supported)
    ? providers.data.supported
    : [];

  useEffect(() => {
    const previous = previousKeyRef.current;
    if (previous && previous !== keyBase) {
      void queryClient.cancelQueries({ queryKey: previous });
      queryClient.removeQueries({ queryKey: previous });
    }
    previousKeyRef.current = keyBase;
    if (meQuery.isPending || (meQuery.isSuccess && canAdmin)) return;
    void queryClient.cancelQueries({ queryKey: keyBase });
    queryClient.removeQueries({ queryKey: keyBase });
  }, [canAdmin, keyBase, meQuery.isPending, meQuery.isSuccess, queryClient]);

  if (meQuery.isPending || meQuery.isError || !canAdmin) {
    return (
      <PageShell className="max-w-5xl">
        <GovernancePageHeader
          icon={KeyRound}
          title="Encryption keys"
          description="Bring your own KMS key so Moosewave can encrypt workspace data under key material you control."
        />
        <GovernanceSection icon={ShieldCheck} title="Admin access required">
          {meQuery.isPending ? (
            <GovernanceLoading label="Checking workspace authority…" rows={2} />
          ) : meQuery.isError ? (
            <GovernanceError
              message="Workspace identity could not be verified. No encryption-key request was made."
              retrying={meQuery.isFetching}
              onRetry={() => void meQuery.refetch()}
            />
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              {ADMIN_READ_ONLY_MESSAGE} No encryption-key configuration was
              fetched.
            </p>
          )}
        </GovernanceSection>
      </PageShell>
    );
  }

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={KeyRound}
        title="Encryption keys"
        description="Bring your own KMS key so Moosewave can encrypt workspace data under key material you control."
        refreshLabel="Refresh key state"
        refreshing={
          keys.isFetching || providers.isFetching || meQuery.isFetching
        }
        onRefresh={() => {
          void keys.refetch();
          void providers.refetch();
        }}
      />

      <GovernanceSection
        icon={ShieldCheck}
        title="Current protection"
        description="Configured providers and supported providers are deliberately kept separate."
      >
        {keys.isPending || providers.isPending ? (
          <GovernanceLoading
            label="Loading encryption-key configuration…"
            rows={3}
          />
        ) : keys.isError || providers.isError ? (
          <GovernanceError
            message="Could not read the key configuration. Nothing has been shown as configured—on an encryption surface, an unknown state must never read as a protected one."
            retrying={keys.isFetching || providers.isFetching}
            onRetry={() => {
              void keys.refetch();
              void providers.refetch();
            }}
          />
        ) : keyRows.length === 0 && configured.length === 0 ? (
          <div className="rounded-xl border border-warning/25 bg-warning-subtle p-4">
            <Badge variant="warning">Moosewave-managed keys</Badge>
            <p className="mt-2 text-sm leading-6 text-warning-emphasis">
              No customer-managed key is configured. Workspace data is encrypted
              under Moosewave&apos;s own keys.
            </p>
            <p className="mt-1 text-xs leading-5 text-warning-emphasis">
              {supported.length > 0
                ? `This build supports ${supported.length.toLocaleString()} KMS provider${supported.length === 1 ? "" : "s"}, but support is not configuration.`
                : "No KMS providers are available in this build."}
            </p>
          </div>
        ) : (
          <GovernanceMetrics
            items={[
              {
                label: "Customer-managed keys",
                value: keyRows.length.toLocaleString(),
                detail: "Keys returned for this workspace",
              },
              {
                label: "Configured providers",
                value: configured.length.toLocaleString(),
                detail: "Actually connected by this workspace",
              },
              {
                label: "Supported providers",
                value: supported.length.toLocaleString(),
                detail: "Available in this build, not necessarily configured",
              },
            ]}
          />
        )}
      </GovernanceSection>

      {!keys.isPending && !keys.isError ? (
        <GovernanceSection
          icon={KeyRound}
          title="Customer-managed keys"
          description="Key aliases, providers, and the status reported by the server."
        >
          {keyRows.length === 0 ? (
            <GovernanceEmpty>
              No customer-managed keys configured.
            </GovernanceEmpty>
          ) : (
            <ul className="divide-y rounded-xl border">
              {keyRows.map((k, i) => (
                <li
                  key={String(k.id ?? i)}
                  className="flex min-w-0 flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium">
                      {String(k.alias ?? k.id ?? `Key ${i + 1}`)}
                    </p>
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {String(k.provider ?? "Provider not reported")}
                    </p>
                  </div>
                  <Badge
                    className="w-fit capitalize"
                    variant={k.status === "active" ? "success" : "outline"}
                  >
                    {k.status?.replace(/_/gu, " ") || "Status not reported"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </GovernanceSection>
      ) : null}

      {!providers.isPending && !providers.isError && supported.length > 0 ? (
        <GovernanceSection
          icon={CloudCog}
          title="Provider availability"
          description="Available in this build does not mean configured for this workspace."
        >
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-medium">Configured here</h3>
              {configured.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">None.</p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {configured.map((provider, index) => (
                    <li key={`${providerLabel(provider)}:${index}`}>
                      <Badge variant="success">{providerLabel(provider)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-medium">Supported by this build</h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {supported.map((provider, index) => (
                  <li key={`${providerLabel(provider)}:${index}`}>
                    <Badge variant="outline">{providerLabel(provider)}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </GovernanceSection>
      ) : null}
    </PageShell>
  );
}
