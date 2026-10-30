/**
 * detailSeedKeys — the list-cache PREFIXES a detail header seeds itself from,
 * and the rule for choosing which of the candidate strings to show.
 *
 * Why these literals live here rather than beside their hooks: the seed is a
 * cross-screen read. `app/(tabs)/campaigns/[id].tsx` has to address the cache
 * that `src/hooks/useCampaigns.ts` wrote, and if the two spell the key
 * differently the seed silently returns nothing — a failure with no symptom
 * except the blank header it was built to remove. One exported builder, used
 * by BOTH the writer and the reader, makes that drift impossible.
 *
 * Import-free on purpose (no react-native, no @tanstack/react-query) so the
 * prefixes and the picker are unit-testable in the node environment — see
 * src/lib/detailSeedKeys.test.ts. `useCachedRowSeed` does the cache read.
 *
 * KEY ORDER IS LOAD-BEARING. TanStack's `getQueriesData` partial-matches
 * POSITIONALLY, so every one of these must stay a true prefix of the key the
 * hook registers:
 *
 *   campaigns  ["campaigns", tenantId]                       useCampaignsList
 *              ["campaigns", tenantId, "paged", …]           useCampaignsPaginated
 *   sequences  ["sequences", tenantId, userId, role, mode]   useSequenceList
 *   assets     ["assets", tenantId, …filters]              useAssetLibrary
 *   templates  ["campaign-templates", tenantId, …filters]  useTemplateCatalog
 *   archive    ["archive", tenantId, …]                    useArchiveIssues
 *
 * The last three moved here from their hook files for a second reason on top
 * of drift: those modules are `jest.mock`-ed wholesale by the screen tests, so
 * a prefix exported from one of them is `undefined` at render time inside
 * every one of those suites — a real crash that only the route suite sees.
 */

/** Prefix matching every campaigns-list query (plain list and paged/search). */
export function campaignsQueryRootKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["campaigns", tenantId ?? null];
}

/**
 * Prefix matching every asset-library query variant (search, filter, folder,
 * tag, sort). `useAssets` builds its full key FROM this, so the two cannot
 * drift into addressing different caches.
 */
export function assetLibraryQueryRootKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["assets", tenantId ?? null];
}

/** Prefix matching every template-catalogue variant; see above. */
export function templateCatalogQueryRootKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["campaign-templates", tenantId ?? null];
}

/** Prefix matching every archive-issues query variant; see above. */
export function archiveIssuesQueryRootKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["archive", tenantId ?? null];
}

/** Prefix matching every sequences-list query variant. */
export function sequencesQueryRootKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["sequences", tenantId ?? null];
}

/**
 * The first candidate that is a real, non-blank string.
 *
 * Used to order a header's sources by TRUSTWORTHINESS: the loaded detail
 * first, then the cached list row, then the static noun. Written as an
 * explicit helper rather than a chain of `??` because `??` only rejects
 * null/undefined — a row whose name is `""` or `"   "` would win the chain
 * and render a header that looks broken rather than loading.
 *
 * Returns undefined (never `""`) so callers can hand the result straight to
 * an optional prop under exactOptionalPropertyTypes.
 */
export function firstMeaningful(
  ...candidates: readonly (string | null | undefined)[]
): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
