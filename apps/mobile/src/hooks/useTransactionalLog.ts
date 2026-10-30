/**
 * hooks/useTransactionalLog.ts — recent transactional sends, unknown ones first.
 *
 * `viewer` + reviewed, so it runs for anyone signed in. The default query asks the
 * server for `attempt_state=unknown` — the handler's own documented triage slice —
 * rather than pulling the whole log and filtering on the phone: the unknown set is
 * small by definition and the full log is not.
 */
import { useQuery } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseTransactionalSends,
  type TransactionalSend,
} from "@/lib/transactionalLog";

const KEY = "transactional-log";

export function useUnresolvedTransactionalSends() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId, "unknown"],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<TransactionalSend[]> => {
      const res = await rawRequest<unknown>(
        "GET",
        "/api/v1/emails?attempt_state=unknown&limit=25",
      );
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return parseTransactionalSends(res.data);
    },
  });
}
