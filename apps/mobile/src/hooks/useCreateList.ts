/**
 * useCreateList — POST /api/v1/lists.
 *
 * Deliberately its OWN module rather than living beside `useListOptions`,
 * which is the catalogue query it invalidates. It needs `@/api/request` for
 * the error CODE (the SDK path drops it), and `@/api/request` transitively
 * imports react-native via sdkClient → store/auth. useListOptions.ts is
 * imported by three node-environment vitest suites, so putting this hook
 * there turned all three into "Flow is not supported" parse failures at
 * react-native/index.js. The screens that need both simply import both.
 *
 * Wire contract, role boundary and failure copy: src/lib/listCreate.ts.
 *
 * NOT queued offline. The create is not idempotent from the client's side
 * (the server's idempotency middleware keys on a header this app does not
 * mint), so replaying it later from a stale phone could produce two lists
 * with the same name and no way to tell which one the operator meant.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { listCatalogueKey } from "@/hooks/useListOptions";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  createListBody,
  createListFailure,
  type ListOptin,
  type ListType,
} from "@/lib/listCreate";

export function useCreateList() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      type: ListType;
      optin: ListOptin;
    }) => {
      const res = await rawRequest<{ id?: number | string; name?: string }>(
        "POST",
        "/api/v1/lists",
        createListBody(input),
      );
      if (res.error) {
        throw Object.assign(new Error(createListFailure(res.error)), res.error);
      }
      return res.data;
    },
    onSuccess: () => {
      // The catalogue backs the lists screen, the add-to-list picker and the
      // subscriber memberships card; invalidate the whole prefix.
      void queryClient.invalidateQueries({
        queryKey: listCatalogueKey(gate.tenantId),
      });
    },
  });
}
