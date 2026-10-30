/**
 * useDomainOps — custom sending domains: list (offline-capable), verify, add
 * and remove.
 *
 * The phone is where the registrar app lives, so the whole loop belongs here:
 * add the domain, read the generated DNS records, copy each into the registrar,
 * tap Re-verify. `useOps.ts` wired list + verify and stopped, so a typo'd
 * domain could not be removed from mobile at all.
 *
 * Endpoints (SDK-wrapped, already present and previously unused):
 *   GET    /api/v1/custom-domains
 *   POST   /api/v1/custom-domains            {domain, purpose}
 *   POST   /api/v1/custom-domains/{id}/verify
 *   DELETE /api/v1/custom-domains/{id}
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import {
  parseCustomDomains,
  type CustomDomain,
} from "@/lib/deliverabilityContracts";
import {
  loadSnapshotBacked,
  snapshotScope,
  type SnapshotBacked,
} from "@/lib/deliverabilitySnapshots";

export type { CustomDomain };

export type CustomDomainPurpose = "forms" | "links" | "web";

export const CUSTOM_DOMAIN_PURPOSES: readonly {
  value: CustomDomainPurpose;
  label: string;
}[] = [
  { value: "links", label: "Links" },
  { value: "forms", label: "Forms" },
  { value: "web", label: "Web" },
];

/**
 * Writes here are online-only. Verify is idempotent and would be safe to
 * queue, but a queued verification that reports success minutes later, after
 * the operator has left the registrar app, is worse than an honest refusal.
 */
export class DomainOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor(action: string) {
    super(`${action} needs a connection. Reconnect and try again.`);
    this.name = "DomainOfflineError";
  }
}

export function useCustomDomains() {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  return useQuery({
    queryKey: [
      "custom-domains",
      gate.tenantId,
      gate.userId,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled: gate.canReadOfflineSnapshots,
    networkMode: "always",
    queryFn: (): Promise<SnapshotBacked<CustomDomain[]>> =>
      loadSnapshotBacked({
        resource: "custom-domains",
        scope,
        canUseNetwork: gate.enabled,
        loadNetwork: async () => {
          const { client } = getClient();
          return parseCustomDomains(await client.customDomains.list());
        },
        unavailableMessage:
          "No saved copy of your domains is available offline.",
      }),
  });
}

function useDomainInvalidation() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["custom-domains", tenantId] });
    void queryClient.invalidateQueries({ queryKey: ["dns-health", tenantId] });
  };
}

export function useVerifyCustomDomain() {
  const invalidate = useDomainInvalidation();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!isProbablyOnline()) throw new DomainOfflineError("Re-verify");
      const { client } = getClient();
      return client.customDomains.verify(id);
    },
    onSuccess: invalidate,
  });
}

export function useCreateCustomDomain() {
  const invalidate = useDomainInvalidation();
  return useMutation({
    mutationFn: async (input: {
      domain: string;
      purpose: CustomDomainPurpose;
    }) => {
      if (!isProbablyOnline()) throw new DomainOfflineError("Adding a domain");
      const { client } = getClient();
      return client.customDomains.create({
        domain: input.domain.trim().toLowerCase(),
        purpose: input.purpose,
      });
    },
    onSuccess: invalidate,
  });
}

export function useDeleteCustomDomain() {
  const invalidate = useDomainInvalidation();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!isProbablyOnline()) throw new DomainOfflineError("Removing a domain");
      const { client } = getClient();
      return client.customDomains.delete(id);
    },
    onSuccess: invalidate,
  });
}

/** Normalise operator input before it reaches the API ("HTTPS://Mail.Acme.com/"). */
export function normalizeDomainInput(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}
