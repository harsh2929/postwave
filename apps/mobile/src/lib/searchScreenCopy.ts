/**
 * lib/searchScreenCopy.ts — the words the search screen says, and the rules
 * that pick between them.
 *
 * The PURE half of the search surface, split the way `src/api/eventBus.ts`
 * grew `eventBusStream.ts`/`eventBusConnection.ts`. The screen's whole reason
 * for existing is that it used to LIE — a 500, an expired session and airplane
 * mode all rendered as "No matches.", an authoritative claim that the
 * workspace contains no such subscriber. The predicates that keep those three
 * apart are therefore the part most worth asserting, and they could not be
 * asserted at all while they lived inside react-native components.
 *
 * WHAT STAYS IN THE COMPONENTS: which ladder rung wins (that is a render
 * decision, and `components/search/SearchStates.tsx` owns it), the styling and
 * the retry wiring. Only strings and string-choosing predicates live here.
 *
 * This module must stay free of react-native/expo imports so it keeps running
 * under `vitest --environment node`.
 */

/** Characters before the server is asked anything. Below this it is local-only. */
export const MIN_QUERY = 2;

/**
 * Offline copy, shared by the header notice and the empty state so the two
 * paths cannot drift. "Screens above still work offline" is load-bearing: the
 * local "Go to" palette is unaffected, and a bare "you're offline" would read
 * as though the whole screen had stopped.
 */
export const SEARCH_OFFLINE_NOTICE =
  "Search needs a connection. Screens above still work offline.";

/**
 * The footer's caveat, or null when there is nothing to caveat.
 *
 * PARTIAL OUTRANKS TRUNCATED. Both can be true at once, and they mean
 * different things: truncated says "there are more of these", partial says
 * "some sources never answered". Only one line fits, and the reader needs the
 * one that says the result set may be WRONG rather than merely short.
 */
export function searchFooterNotice(
  partial: boolean,
  truncated: boolean,
): string | null {
  if (partial) {
    return "Some sources didn't answer, so these results may be incomplete.";
  }
  if (truncated) {
    return "Showing the first matches — refine your search to narrow them.";
  }
  return null;
}

/**
 * The bottom rung of the empty ladder — reached only once error, offline and
 * loading have all been ruled out.
 *
 * "No matches." is only ever said when the server WAS asked and answered.
 */
export function searchEmptyCopy(searching: boolean): string {
  return searching
    ? "No matches."
    : `Type at least ${MIN_QUERY} characters to search subscribers, campaigns, lists and tags.`;
}
