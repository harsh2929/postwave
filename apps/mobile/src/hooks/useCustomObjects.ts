/**
 * hooks/useCustomObjects.ts — query wiring for the custom-object records
 * browser. Reads only; the surface has no mutation.
 *
 * TYPES ARE ALMOST STATIC, RECORDS ARE NOT. A workspace defines a handful of
 * object types and changes them rarely (and never from a phone), so the type
 * list gets a long window. The records under it are business data that moves,
 * so they get a short one and the screen states when it last read them.
 */
import { useQuery } from "@tanstack/react-query";

import {
  listCustomObjectRecords,
  listCustomObjectTypes,
} from "@/api/customObjects";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  CustomObjectRecordsPage,
  CustomObjectType,
} from "@/lib/customObjectRecords";

const TYPES_STALE_MS = 300_000;
const RECORDS_STALE_MS = 30_000;

export function useCustomObjectTypes() {
  const gate = useOnlineQueryGate();
  return useQuery<CustomObjectType[]>({
    queryKey: ["custom-objects", "types", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: TYPES_STALE_MS,
    queryFn: () => listCustomObjectTypes(),
  });
}

export function useCustomObjectRecords(typeId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery<CustomObjectRecordsPage>({
    queryKey: ["custom-objects", "records", gate.tenantId, typeId],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(typeId),
    staleTime: RECORDS_STALE_MS,
    queryFn: () => listCustomObjectRecords(String(typeId)),
  });
}
