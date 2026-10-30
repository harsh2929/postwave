/**
 * lib/desktopOnlyCapabilities.ts — what Moosewave does that this phone does NOT.
 *
 * ── THE PROBLEM (MAP#73) ───────────────────────────────────────────────────
 * More presents six confident section headings — Audience, Tools, Sending,
 * Content, Enterprise, Account — over 55 rows. A heading is a CLAIM about
 * coverage, and a user scanning "Content" and not finding Referrals reasonably
 * concludes Moosewave has no referral programme, not that it has one on
 * desktop. The menu had no way to say "this exists, just not here", so its
 * only available answer to a missing capability was silence, and silence reads
 * as absence.
 *
 * The fix is not another section. It is a short, honest closing block that
 * names the capabilities the product has and the phone does not, so the
 * taxonomy above it stops being read as exhaustive.
 *
 * ── WHERE THE LEDGER ITSELF LIVES ──────────────────────────────────────────
 * The block is data rather than prose, and that data is the coverage ledger,
 * split across two sibling modules and re-exported here so the old import
 * surface is unchanged: `desktopSectionCoverage.ts` (anchored to apps/desktop's
 * sidebar catalogue, and carrying the argument for why the list is a table)
 * and `webSectionCoverage.ts` (anchored to apps/web's dashboard directories).
 * `desktopOnlyCapabilities.test.ts` reconciles both. THIS file holds only the
 * half a user reads.
 *
 * Import-free of react-native/expo by construction (its only runtime import is
 * `lib/i18n`, itself import-free), so every rule above is unit-tested under
 * node. Copy lives in the catalogue — see `i18nCoverage.test.ts`'s COVERED.
 */
import { msg, type SimpleMessageKey } from "@/lib/i18n";

export type { MobileCoverage } from "@/lib/mobileCoverage";
// NOT re-exported either, for the same reason: DESKTOP_SECTION_COVERAGE and
// OUTBOUND_WEBHOOK_DIAGNOSTIC_COVERAGE live in @/lib/desktopSectionCoverage and
// are read only by desktopOnlyCapabilities.test.ts. This file mentions the first
// in a comment below and uses neither.
//
// NOT re-exported: `WEB_SECTION_COVERAGE` lives in @/lib/webSectionCoverage and
// its only consumer is desktopOnlyCapabilities.test.ts, which now imports it
// directly. Re-exporting it here for the test's convenience put the whole
// 23 KB registry — a verdict table about apps/web's routes, with no runtime
// behaviour — into the shipped bundle, because MoreDesktopOnly imports this
// module and Metro follows a barrel re-export whether or not anything reads it.

export interface DesktopOnlyCapability {
  /** The desktop sidebar section id this row is about. */
  section: string;
  /** Catalogue key for the capability's name. */
  labelKey: SimpleMessageKey;
  /** Catalogue key for the one line saying what you would go there to do. */
  hintKey: SimpleMessageKey;
}

/**
 * The closing block's rows, in the order they read best: the two growth
 * programmes first (the ones a marketer is most likely to look for), then the
 * operator/developer tools.
 *
 * Every entry MUST be `absent` in `DESKTOP_SECTION_COVERAGE` — the test
 * enforces it, so this list can never claim a capability the phone actually
 * has.
 */
export const DESKTOP_ONLY_CAPABILITIES: readonly DesktopOnlyCapability[] = [
  {
    section: "affiliates",
    labelKey: "desktopOnly.affiliates.label",
    hintKey: "desktopOnly.affiliates.hint",
  },
  {
    section: "aiChangelog",
    labelKey: "desktopOnly.aiChangelog.label",
    hintKey: "desktopOnly.aiChangelog.hint",
  },
  {
    section: "apiPlayground",
    labelKey: "desktopOnly.apiPlayground.label",
    hintKey: "desktopOnly.apiPlayground.hint",
  },
  {
    section: "webhookSimulator",
    labelKey: "desktopOnly.webhookSimulator.label",
    hintKey: "desktopOnly.webhookSimulator.hint",
  },
];

export interface DesktopOnlyRow {
  section: string;
  label: string;
  hint: string;
}

/** The rows to render, with copy resolved through the message catalogue. */
export function desktopOnlyRows(): DesktopOnlyRow[] {
  return DESKTOP_ONLY_CAPABILITIES.map((capability) => ({
    section: capability.section,
    label: msg(capability.labelKey),
    hint: msg(capability.hintKey),
  }));
}

/** Heading for the closing block. */
export function desktopOnlyHeading(): string {
  return msg("desktopOnly.heading");
}

/**
 * The block's explanation. Deliberately says WHY rather than apologising: the
 * point is to correct the reader's model of the menu above, not to promise a
 * roadmap the app cannot keep.
 */
export function desktopOnlyBody(): string {
  return msg("desktopOnly.body");
}

/** What a screen reader announces for the whole block, in one breath. */
export function desktopOnlyAccessibilityLabel(): string {
  const names = desktopOnlyRows()
    .map((row) => row.label)
    .join(", ");
  return msg("desktopOnly.a11y", { names });
}
