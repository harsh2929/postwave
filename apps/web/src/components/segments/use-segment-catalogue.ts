// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";

import { base, STALE, type RoleKey } from "@/lib/query-keys";
import { getPredicateRegistry, listCustomFields } from "@/lib/segments-api";

import type { FieldDef } from "./field-picker";
import { fallbackFieldDefs, registryToFieldDefs } from "./segment-catalogue";

/** The builder catalogue and whether it had to fall back. */
export interface FieldCatalogue {
  fields: FieldDef[];
  /** The registry failed; `fields` are the built-ins (+ custom fields). */
  degraded: boolean;
}

/** What {@link useSegmentCatalogue} reports. */
export interface SegmentCatalogueState {
  /** Undefined until the registry answers or its fallback is ready. */
  data: FieldCatalogue | undefined;
  /** Nothing to show yet: stored rules can't be labelled truthfully. */
  isPending: boolean;
  /** Asks the registry again; the fallback stays up meanwhile. */
  refetch: () => Promise<unknown>;
}

/**
 * The segment field catalogue for a workspace, shared by the builder and the
 * read-only definition view (one cache entry). It comes from the predicate
 * registry. Only when the registry has failed, after the client's usual
 * retries, does the builder fall back to the built-in fields plus the
 * custom-fields list, and the result then says so.
 *
 * A failure is kept as the registry query's error, not cached as data: the
 * fallback is never mistaken for a fresh catalogue, and the registry is asked
 * again on the next mount, reconnect or Retry instead of a day later.
 */
export function useSegmentCatalogue(
  tenantId: string,
  role: RoleKey,
  enabled: boolean,
): SegmentCatalogueState {
  const registry = useQuery({
    queryKey: [...base("segment-fields", tenantId, role)],
    enabled,
    staleTime: STALE.reference,
    queryFn: async (): Promise<FieldDef[]> => {
      const response = await getPredicateRegistry();
      const fields = registryToFieldDefs(
        Array.isArray(response?.predicates) ? response.predicates : [],
      );
      if (fields.length === 0) {
        throw new Error("The predicate registry offered no fields.");
      }
      return fields;
    },
  });
  const degraded = registry.isError && registry.data === undefined;
  const fallback = useQuery({
    queryKey: [...base("segment-fields-fallback", tenantId, role)],
    enabled: enabled && degraded,
    staleTime: STALE.reference,
    queryFn: async (): Promise<FieldDef[]> => {
      const custom = await listCustomFields().catch(() => null);
      return fallbackFieldDefs(Array.isArray(custom) ? custom : null);
    },
  });

  let data: FieldCatalogue | undefined;
  if (registry.data !== undefined) {
    data = { fields: registry.data, degraded: false };
  } else if (degraded && fallback.data !== undefined) {
    data = { fields: fallback.data, degraded: true };
  }
  return {
    data,
    isPending: data === undefined,
    refetch: registry.refetch,
  };
}
