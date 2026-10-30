/**
 * lib/i18n.ts — the translation SEAM.
 *
 * What this is and, more importantly, what it is not: Moosewave mobile ships
 * ~1,260 user-facing strings as English literals. Translating them is a
 * multi-release programme with a vendor attached. What was missing was not the
 * translations — it was any PLACE to put them, and any way to stop the next
 * 200 strings being written in a shape that cannot be translated at all. This
 * module is that place; `messagesEn.ts` is the catalogue; and
 * `i18nCoverage.test.ts` fails the build when a covered file grows a new
 * hardcoded literal. Shipping the seam plus the ratchet is honest. Shipping a
 * half-populated `fr.json` would not be: a screen where the header is French
 * and the body is English reads worse than one that is consistently English.
 *
 * ── WHY THE FUNCTION IS `msg` AND NOT `t` ──────────────────────────────────
 * Every convention in the world calls this `t`. This codebase cannot: `t` is
 * already the THEME TOKEN BAG, destructured as `const { t } = useTheme()` in
 * 445 files / 720 call sites. A second `t` in scope would shadow the first in
 * whichever order the two lines happen to appear, and the failure mode is not
 * a type error — `t.fgMuted` on a translate function is `undefined`, which
 * React Native renders as an invisible/black colour rather than throwing. A
 * naming convention is not worth a class of silent styling bugs, so the
 * function is `msg` and the reason is written down here.
 *
 * ── WHAT IT ACTUALLY BUYS TODAY, IN ENGLISH ────────────────────────────────
 * `Intl.PluralRules` instead of `n === 1 ? x : x + "s"`. Even before a single
 * translation exists, that is the difference between a catalogue a translator
 * can work with and one they cannot: Polish selects among four categories,
 * Arabic six, Japanese one. Hand-rolled binary pluralisation bakes the English
 * answer into the call site, which is exactly what the finding named.
 *
 * ── DEGRADATION ────────────────────────────────────────────────────────────
 *  - `Intl.PluralRules` missing (some Hermes/Android builds ship a reduced
 *    ICU): fall back to the binary rule, i.e. today's behaviour. A missing
 *    Intl API must not crash a count line.
 *  - Locale with no registered catalogue: fall back to the base catalogue.
 *    Regional first (`pt-BR`), then the bare language (`pt`) — a region we do
 *    not have is not a reason to discard a language we do.
 *  - Key missing from BOTH: return the key. It is ugly on screen and that is
 *    the point; and because keys are literal-typed off the base catalogue,
 *    tsc catches it long before a user does.
 *
 * Import-free of react-native/expo (its only import is `lib/format`, which is
 * itself import-free), so every rule above is unit-tested under node.
 */
import { num } from "@/lib/format";
import { EN_MESSAGES } from "@/lib/messagesEn";

/** CLDR plural categories. `other` is the only one every language has. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/**
 * A counted message. `other` is required because it is the universal
 * fallback — a catalogue entry without it has no answer for a category the
 * translator did not think to fill in.
 */
export type PluralMessage = { readonly other: string } & {
  readonly [K in Exclude<PluralCategory, "other">]?: string;
};

export type Message = string | PluralMessage;
export type Catalogue = Readonly<Record<string, Message>>;

/** Interpolation values. Numbers are grouped through `lib/format`'s `num()`. */
export type MessageParams = Readonly<Record<string, string | number>>;

type BaseCatalogue = typeof EN_MESSAGES;

/** Every key the app knows. A typo here is a compile error. */
export type MessageKey = keyof BaseCatalogue;

/** Keys whose entry is counted, so `pluralMsg` is the only way to read them. */
export type PluralMessageKey = {
  [K in MessageKey]: BaseCatalogue[K] extends string ? never : K;
}[MessageKey];

/** Keys whose entry is a plain string. */
export type SimpleMessageKey = Exclude<MessageKey, PluralMessageKey>;

const BASE: Catalogue = EN_MESSAGES;

/** Registered translations, keyed by the tag they were registered under. */
const catalogues = new Map<string, Catalogue>();

let activeTag: string | null = null;
let active: Catalogue | null = null;
let rules: Intl.PluralRules | null = null;

/** Keys that were asked for and did not exist — read by diagnostics/tests. */
const missing = new Set<string>();

/**
 * Add a translation catalogue. Nothing calls this yet; it is the hole a
 * translation drop plugs into, and it exists so that "add a language" is a
 * data change rather than a refactor of every call site.
 *
 * Entries are merged over the base at LOOKUP time, not at registration time,
 * so a partial catalogue degrades key-by-key to English instead of blanking
 * every sentence the translator has not reached yet.
 */
export function registerCatalogue(tag: string, catalogue: Catalogue): void {
  const key = tag.trim().toLowerCase();
  if (!key) return;
  catalogues.set(key, catalogue);
  // A catalogue registered for the tag we are already running under must take
  // effect without a second setMessageLocale() call.
  if (activeTag && matchCatalogue(activeTag) === catalogue) active = catalogue;
}

function matchCatalogue(tag: string): Catalogue | null {
  const lower = tag.trim().toLowerCase();
  if (!lower) return null;
  const exact = catalogues.get(lower);
  if (exact) return exact;
  const dash = lower.indexOf("-");
  if (dash > 0) {
    const language = catalogues.get(lower.slice(0, dash));
    if (language) return language;
  }
  return null;
}

/**
 * Point the app at a locale. Called from `lib/localization.ts` next to
 * `setFormatLocale`, so messages and numbers can never disagree about which
 * locale the app is running under.
 *
 * The tag is used for PLURAL SELECTION even when no catalogue is registered
 * for it — that is not a contradiction. English text under Russian plural
 * rules would be wrong, so selection stays on the tag whose catalogue we
 * actually resolved; see `pluralTag`.
 */
export function setMessageLocale(tag: string | undefined): void {
  activeTag = tag?.trim() ? tag.trim() : null;
  active = activeTag ? matchCatalogue(activeTag) : null;
  rules = null;
  missing.clear();
}

/** The tag messages are being read under, or null for the base catalogue. */
export function activeMessageLocale(): string | null {
  return active ? activeTag : null;
}

/** Keys asked for that exist in no catalogue. Empty is the healthy state. */
export function missingMessageKeys(): readonly string[] {
  return [...missing].sort();
}

/**
 * Which locale's plural rules apply.
 *
 * Deliberately the locale of the TEXT, not of the device: if the device is
 * `ru-RU` and no Russian catalogue is registered, the sentence rendering is
 * English, and English text must be selected with English rules or "2 файла"
 * grammar picks the wrong English clause. Falls back to `en`.
 */
function pluralTag(): string {
  return active && activeTag ? activeTag : "en";
}

function categoryFor(count: number): PluralCategory {
  if (!Number.isFinite(count)) return "other";
  // Feature-detected: a reduced-ICU Hermes build has no PluralRules at all,
  // and a missing Intl API must degrade, never throw inside a count line.
  if (typeof Intl.PluralRules === "function") {
    try {
      rules ??= new Intl.PluralRules(pluralTag());
      return rules.select(count) as PluralCategory;
    } catch {
      // A tag Intl rejects: fall through to the binary rule rather than
      // letting one bad locale take out every counted string in the app.
    }
  }
  return count === 1 ? "one" : "other";
}

function lookup(key: string): Message | undefined {
  const translated = active?.[key];
  if (translated !== undefined) return translated;
  const base = BASE[key];
  if (base === undefined) missing.add(key);
  return base;
}

/**
 * Substitute `{name}` placeholders.
 *
 * NUMBERS ARE GROUPED. Every number the app shows elsewhere goes through
 * `lib/format`'s `num()`, so an un-grouped `1000` inside a sentence would be
 * the one place in the product that disagrees with itself. A caller that wants
 * raw digits passes a string.
 *
 * An unsupplied placeholder is left VISIBLE (`{count}`) rather than blanked:
 * a literal brace in QA is a bug report, an empty gap is a sentence that
 * silently lost its number.
 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => {
    const value = params[name];
    if (typeof value === "number") return num(value);
    if (typeof value === "string") return value;
    return whole;
  });
}

/** Read a plain (uncounted) message. */
export function msg(key: SimpleMessageKey, params?: MessageParams): string {
  const entry = lookup(key);
  if (entry === undefined) return key;
  // A key that is simple in the base catalogue can still arrive as a plural
  // entry from a translation — Slovenian may need to count a sentence English
  // does not. Honour it with the count the caller gave, or `other`.
  if (typeof entry !== "string") {
    return interpolate(selectPlural(entry, params?.count), params);
  }
  return interpolate(entry, params);
}

/**
 * Read a counted message. `count` is a required positional argument rather
 * than another entry in `params` so that it cannot be forgotten — forgetting
 * it is precisely how a plural silently collapses to one form.
 *
 * It is also merged into the params, so `{count}` renders without the caller
 * passing the number twice.
 */
export function pluralMsg(
  key: PluralMessageKey,
  count: number,
  params?: MessageParams,
): string {
  const entry = lookup(key);
  if (entry === undefined) return key;
  const merged: MessageParams = { ...params, count };
  if (typeof entry === "string") return interpolate(entry, merged);
  return interpolate(selectPlural(entry, count), merged);
}

function selectPlural(
  entry: PluralMessage,
  count: string | number | undefined,
): string {
  if (typeof count !== "number") return entry.other;
  const category = categoryFor(count);
  return entry[category] ?? entry.other;
}

/** One diagnostics line: which catalogue is live and what it is missing. */
export function messageCatalogueSummary(): string {
  const where = active && activeTag ? activeTag : "en (base)";
  const gaps = missing.size;
  return gaps === 0 ? where : `${where} · ${gaps} missing key(s)`;
}
