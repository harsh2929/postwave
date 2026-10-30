/**
 * Identity-scoped read + replacement of the Customer Hub configuration record.
 *
 * Reuses the Helpdesk access gate (`useHelpdeskAccess`) because this record is
 * the Helpdesk's own admin surface and answers to the same `admin` session
 * role. The query key carries the full identity tuple so a workspace or role
 * change cannot serve one operator the other's verified record, and nothing
 * here is persisted (`shouldPersistQuery` is false for every query).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  fetchCustomerHubConfig,
  replaceCustomerHubConfig,
  type CustomerHubResource,
} from "@/api/customerHub";
import {
  assertCurrentHelpdeskIdentity,
  HelpdeskIdentityRetiredError,
  reauthorizeHelpdeskIdentity,
  type HelpdeskAccess,
  type HelpdeskIdentity,
} from "@/hooks/useHelpdesk";
import {
  customerHubWriteOutcomeIsAmbiguous,
  type CustomerHubDraft,
} from "@/lib/customerHub";

export const CUSTOMER_HUB_CONFIG_KEY = "customer-hub-config-v1";
export const CUSTOMER_HUB_WRITE_KEY = "customer-hub-config-write-v1";

function identityKey(identity: HelpdeskIdentity | null) {
  return [
    identity?.fingerprint ?? null,
    identity?.baseUrl ?? null,
    identity?.tenantId ?? null,
    identity?.userId ?? null,
    identity?.effectiveRole ?? null,
    identity?.contextEpoch ?? null,
  ] as const;
}

/**
 * The same pre-flight the Helpdesk mutations run: refuse before the request
 * when the session that opened this screen is no longer the session making it.
 */
function identityOrThrow(access: HelpdeskAccess): HelpdeskIdentity {
  if (!access.canRequest || !access.identity) {
    throw new HelpdeskIdentityRetiredError();
  }
  assertCurrentHelpdeskIdentity(access.identity);
  return access.identity;
}

export function useCustomerHubConfig(
  access: HelpdeskAccess,
  enabled: boolean,
) {
  return useQuery<CustomerHubResource>({
    queryKey: [CUSTOMER_HUB_CONFIG_KEY, ...identityKey(access.identity)],
    enabled: enabled && access.onlineGate.enabled && access.canRequest,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const identity = identityOrThrow(access);
      const resource = await fetchCustomerHubConfig({ signal });
      assertCurrentHelpdeskIdentity(identity);
      return resource;
    },
  });
}

export function useCustomerHubReplace(access: HelpdeskAccess) {
  const client = useQueryClient();
  const controller = useRef<AbortController | null>(null);
  const fingerprint = access.canRequest
    ? (access.identity?.fingerprint ?? null)
    : null;
  useEffect(() => () => controller.current?.abort(), [fingerprint]);

  return useMutation<
    CustomerHubResource,
    Error,
    { resource: CustomerHubResource; draft: CustomerHubDraft }
  >({
    mutationKey: [CUSTOMER_HUB_WRITE_KEY, ...identityKey(access.identity)],
    mutationFn: async ({ resource, draft }) => {
      const identity = identityOrThrow(access);
      await reauthorizeHelpdeskIdentity(identity);
      controller.current?.abort();
      controller.current = new AbortController();
      const replaced = await replaceCustomerHubConfig(resource.config, draft, {
        ifMatch: resource.etag,
        signal: controller.current.signal,
      });
      assertCurrentHelpdeskIdentity(identity);
      return replaced;
    },
    onSuccess: (replaced) => {
      client.setQueryData(
        [CUSTOMER_HUB_CONFIG_KEY, ...identityKey(access.identity)],
        replaced,
      );
    },
    onError: (error) => {
      // The spent ETag cannot be reused, and an ambiguous outcome may have
      // committed. Drop the verified record and force a fresh read rather
      // than letting a second Save ride a validator the server retired.
      // A 412/428 is definitive-no-effect but ALSO means our validator is
      // stale ("The resource changed; refetch it and review before
      // retrying."), so it refetches for the opposite reason.
      const status = (error as { status?: unknown } | null)?.status;
      if (
        customerHubWriteOutcomeIsAmbiguous(error) ||
        status === 412 ||
        status === 428
      ) {
        void client.invalidateQueries({
          queryKey: [
            CUSTOMER_HUB_CONFIG_KEY,
            ...identityKey(access.identity),
          ],
          exact: true,
        });
      }
    },
  });
}
