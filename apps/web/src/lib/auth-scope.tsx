// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface VerifiedAuthScope {
  userId: string;
  tenantId: string;
  canWriteCampaigns: boolean;
}

const VerifiedAuthScopeContext = createContext<VerifiedAuthScope | null>(null);

export function VerifiedAuthScopeProvider({
  scope,
  children,
}: {
  scope: VerifiedAuthScope;
  children?: ReactNode;
}) {
  const value = useMemo(
    () => ({
      userId: scope.userId,
      tenantId: scope.tenantId,
      canWriteCampaigns: scope.canWriteCampaigns,
    }),
    [scope.canWriteCampaigns, scope.tenantId, scope.userId],
  );
  return (
    <VerifiedAuthScopeContext.Provider
      key={`${value.userId}:${value.tenantId}`}
      value={value}
    >
      {children}
    </VerifiedAuthScopeContext.Provider>
  );
}

export function useVerifiedAuthScopeOptional(): VerifiedAuthScope | null {
  return useContext(VerifiedAuthScopeContext);
}

/**
 * Recovery-capable mutations must be bound to the identity verified by the
 * dashboard auth boot. Falling back to an anonymous or cached identity would
 * make durable keys unsafe during an account/workspace transition.
 */
export function useVerifiedAuthScope(): VerifiedAuthScope {
  const scope = useContext(VerifiedAuthScopeContext);
  if (!scope?.userId || !scope.tenantId) {
    throw new Error(
      "A verified user and workspace are required for durable design recovery.",
    );
  }
  return scope;
}
