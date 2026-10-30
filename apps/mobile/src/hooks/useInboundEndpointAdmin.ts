/**
 * hooks/useInboundEndpointAdmin.ts — the three endpoint-lifecycle writes
 * (create / rename / delete), kept beside but separate from
 * `useInboundWebhookOps`, which owns the list and the operate half.
 *
 * `networkMode: "always"` on all three, for the reason the operate half gives
 * in prose and this one enforces in code: react-query's default would PAUSE a
 * mutation started with no connection and fire it whenever the device
 * reconnects. None of these three may be queued —
 *
 *   - a queued CREATE mints a signing secret into a response nobody is
 *     looking at, and the server shows it exactly once;
 *   - a queued DELETE shreds an endpoint's secrets minutes or hours after the
 *     operator decided to, against a world they have moved past;
 *   - a paused mutation is also the one kind the persister may write to disk.
 *
 * "always" makes each fail loudly and immediately instead, which the sheets
 * and the row controls already say will happen.
 */
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import {
  createInboundEndpoint,
  deleteInboundEndpoint,
  isInboundEndpointGone,
  renameInboundEndpoint,
  type InboundEndpointCreated,
} from "@/api/inboundEndpointAdmin";
import { INBOUND_ENDPOINTS_QUERY_ROOT } from "@/lib/inboundEndpointAdmin";

export interface InboundEndpointAdminActions {
  create: UseMutationResult<InboundEndpointCreated, Error, string>;
  rename: UseMutationResult<string, Error, { id: string; name: string }>;
  remove: UseMutationResult<void, Error, string>;
}

export function useInboundEndpointAdminActions(): InboundEndpointAdminActions {
  const qc = useQueryClient();
  // Invalidated by ROOT: the list key carries tenant + user + role + a
  // snapshot marker, and a key reconstructed here that drifted by one segment
  // would silently invalidate nothing.
  const invalidateEndpoints = () => {
    void qc.invalidateQueries({ queryKey: [INBOUND_ENDPOINTS_QUERY_ROOT] });
  };

  const create = useMutation<InboundEndpointCreated, Error, string>({
    mutationFn: (name: string) => createInboundEndpoint(name),
    networkMode: "always",
    onSuccess: invalidateEndpoints,
  });

  const rename = useMutation<string, Error, { id: string; name: string }>({
    mutationFn: ({ id, name }) => renameInboundEndpoint(id, name),
    networkMode: "always",
    onSuccess: invalidateEndpoints,
  });

  const remove = useMutation<void, Error, string>({
    mutationFn: (id: string) => deleteInboundEndpoint(id),
    networkMode: "always",
    onSuccess: invalidateEndpoints,
    // A 404 is not a failed delete, it is a delete someone else already made
    // (or this device made before a response was lost). The list is still
    // showing a row the server does not have, so it is refreshed on that path
    // too — while a genuine 403/500 leaves the cache alone.
    onError: (err) => {
      if (isInboundEndpointGone(err)) invalidateEndpoints();
    },
  });

  return { create, rename, remove };
}
