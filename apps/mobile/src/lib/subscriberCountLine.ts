/**
 * subscriberCountLine — the one line under the subscribers search box that
 * says how much of the workspace you are actually looking at.
 *
 * Three facts have to survive the same sentence, and getting any of them
 * wrong is a quiet lie:
 *
 *  - PAGED vs TOTAL. An infinite list holds N of M rows. "1,340
 *    subscribers" over 25 loaded rows claims the screen shows a workspace
 *    it does not; "Showing 25 of 1,340 subscribers" is the honest form.
 *  - FILTERED vs WHOLE. With a status filter on, the noun is "unsubscribed
 *    subscribers", not "subscribers".
 *  - SEARCH RESULTS are results, not subscribers — the count is of matches.
 *
 * And when the server sends no `total` at all we must not invent one: the
 * line falls back to "N loaded", plus a hint that scrolling gets more.
 *
 * ── WHY THE COPY MOVED OUT OF THIS FILE (LOVE#22) ──────────────────────────
 * This module was the audit's named example of a string nothing could ever
 * translate. It hand-assembled
 *
 *     `Showing ${n} of ${plural(m, filterNoun + " subscriber")}`
 *
 * which freezes three English assumptions into TypeScript: that a count has
 * exactly two forms, that an adjective precedes its noun, and that "Showing X
 * of Y" keeps that word order. All three are now catalogue entries in
 * `lib/messagesEn.ts`, read through `lib/i18n`, so a translator changes the
 * grammar instead of filling blanks inside English syntax. The rendered
 * English is byte-for-byte what it was — the tests below this file pin that.
 *
 * This file is in `i18nCoverage.test.ts`'s covered set, so a new hardcoded
 * sentence here fails the build rather than quietly re-opening the gap.
 *
 * Free of react-native/expo — its imports are `lib/format` and `lib/i18n`,
 * both import-free — so all of that is directly testable under node.
 */

/**
 * Thousands separators come from `lib/format`, the app's one formatting
 * vocabulary — a local `toLocaleString` here would ignore `setFormatLocale()`
 * and drift from every other count on the screen. Pluralisation comes from
 * `lib/i18n`, which selects a CLDR category via `Intl.PluralRules` instead of
 * `format.plural`'s `n === 1` rule.
 */
import { num as group } from "@/lib/format";
import { msg, pluralMsg } from "@/lib/i18n";

export interface CountLineInput {
  /** Rows currently materialised in the infinite query. */
  loaded: number;
  /** The server's total for the CURRENT query, when it sent one. */
  serverTotal: number | undefined;
  /** True when a search term is active. */
  isSearching: boolean;
  /** Status-filter noun, e.g. "unsubscribed". Empty for the "all" chip. */
  filterNoun: string;
  /** Whether another page exists. */
  hasNextPage: boolean;
}

/** The noun one row of this list is, given the active search/filter. */
export function subscriberCountNoun(input: {
  isSearching: boolean;
  filterNoun: string;
}): string {
  if (input.isSearching) return msg("subscribers.noun.result");
  return input.filterNoun
    ? msg("subscribers.noun.filtered", { noun: input.filterNoun })
    : msg("subscribers.noun.subscriber");
}

/**
 * The counted phrase for `count` rows of the current query — the part that
 * needs real plural categories rather than an `n === 1` ternary.
 */
function countedPhrase(input: CountLineInput, count: number): string {
  if (input.isSearching) {
    return pluralMsg("subscribers.count.results", count);
  }
  if (input.filterNoun) {
    return pluralMsg("subscribers.count.filtered", count, {
      noun: input.filterNoun,
    });
  }
  return pluralMsg("subscribers.count.all", count);
}

export function subscriberCountLine(input: CountLineInput): string {
  if (typeof input.serverTotal !== "number") {
    // No total from the server: state only what we can prove.
    return pluralMsg(
      input.hasNextPage
        ? "subscribers.count.loadedMore"
        : "subscribers.count.loaded",
      input.loaded,
    );
  }
  if (input.serverTotal > input.loaded) {
    return msg("subscribers.count.showing", {
      // `group` rather than the raw number, so both figures in the sentence
      // are formatted the same way; `{total}` arrives already pluralised.
      loaded: group(input.loaded),
      total: countedPhrase(input, input.serverTotal),
    });
  }
  return countedPhrase(input, input.serverTotal);
}
