/**
 * lib/templateFavorites.ts — the optimistic half of the template star.
 *
 * Split out of lib/templateCatalog when that module reached its size ceiling;
 * it is also the cleaner home, because this is cache surgery rather than wire
 * parsing.
 *
 * It lives in an import-free module for the usual reason: hooks/
 * useCampaignTemplates cannot be imported by a node vitest (it reaches
 * react-native through the api client), and shape-walking a cached
 * infinite-query payload is exactly the code that fails SILENTLY — a mismatch
 * in the `{ pages: [{ items }] }` envelope leaves the star un-toggled with no
 * error anywhere to notice.
 */
/**
 * Flip one design's `isFavorited` inside a cached infinite-query payload.
 *
 * Anything that is not the expected shape is returned UNCHANGED, so a future
 * envelope change degrades to "no optimistic update" rather than to a wiped
 * cache.
 */
export function patchTemplateFavorite(
  data: unknown,
  id: string,
  favorited: boolean,
): unknown {
  if (!data || typeof data !== "object") return data;
  const pages = (data as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return data;
  return {
    ...(data as object),
    pages: pages.map((page) => {
      if (!page || typeof page !== "object") return page;
      const items = (page as { items?: unknown }).items;
      if (!Array.isArray(items)) return page;
      return {
        ...(page as object),
        items: items.map((item) =>
          item &&
          typeof item === "object" &&
          (item as { id?: unknown }).id === id
            ? { ...(item as object), isFavorited: favorited }
            : item,
        ),
      };
    }),
  };
}
