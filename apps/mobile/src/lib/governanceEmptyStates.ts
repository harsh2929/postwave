/**
 * lib/governanceEmptyStates.ts — the first-run copy for the surfaces whose
 * purpose is least self-evident (GOVERNANCE#30).
 *
 * ── WHY THESE SCREENS AND NOT ALL OF THEM ──────────────────────────────────
 * A first-time admin opening Approvals, Audit, SCIM, Audit sinks or Agency
 * sees a surface with no rows and no context. "No SCIM tokens" and "No
 * approvals on file yet" are DEFICIT statements: they report the absence of a
 * thing whose purpose the reader may not know, on exactly the screens where
 * they are least likely to. A campaign list can get away with "No campaigns" —
 * everyone knows what a campaign is. An audit sink cannot.
 *
 * So each entry answers two questions in two clauses, always in this order:
 *
 *   1. WHAT THIS SURFACE IS FOR — one sentence, in the reader's terms, never
 *      restating the noun in the title.
 *   2. WHERE ITS CONTENT COMES FROM — what has to happen for a row to appear.
 *      An empty governance screen is usually not a problem to be fixed but a
 *      state to be understood, and "nothing has happened yet" is a materially
 *      different message from "you have not set this up".
 *
 * ── WHY A SHARED MODULE RATHER THAN SIX GOOD PARAGRAPHS ────────────────────
 * The finding's complaint is not that any one line is bad — several of these
 * screens already carry careful copy. It is that there is no SHARED content,
 * so the six drift: three say "from desktop", two say "on desktop", one
 * apologises. One module means the governance surfaces speak with one voice,
 * and it means the next governance screen inherits the shape instead of
 * inventing a seventh.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * No CTAs. Every one of these is created on desktop (SCIM tokens, sinks, alert
 * rules) or is produced by other people's actions (approvals, audit events);
 * a button here could only navigate somewhere that cannot help. A "Create" CTA
 * that opens a screen with no create verb is worse than no CTA.
 *
 * FILTERED states are NOT here. "Nothing matches your filter" is about the
 * filter, not about the surface, and the screens already say it well. Handing
 * that case to a shared module would flatten a real distinction — an admin who
 * narrowed to `failed` and saw nothing has learned something good.
 *
 * Import-free of react-native/expo (only `lib/i18n`, itself import-free), so
 * the whole table is unit-tested under node. Copy lives in the catalogue.
 */
import { msg, type SimpleMessageKey } from "@/lib/i18n";

/**
 * The catalogue keys for each governance surface, written out rather than
 * assembled from the surface name.
 *
 * A template-built key (`governance.empty.${surface}.title`) would have to be
 * cast to `SimpleMessageKey`, and that cast is the whole safety property of
 * this seam thrown away: `lib/i18n` gives `msg()` LITERAL key types precisely
 * so a missing entry is a compile error rather than a key rendering itself on
 * screen. Six pairs written out keep tsc as the guard.
 */
const KEYS = {
  approvals: {
    title: "governance.empty.approvals.title",
    body: "governance.empty.approvals.body",
  },
  audit: {
    title: "governance.empty.audit.title",
    body: "governance.empty.audit.body",
  },
  scimTokens: {
    title: "governance.empty.scimTokens.title",
    body: "governance.empty.scimTokens.body",
  },
  scimMappings: {
    title: "governance.empty.scimMappings.title",
    body: "governance.empty.scimMappings.body",
  },
  auditSinks: {
    title: "governance.empty.auditSinks.title",
    body: "governance.empty.auditSinks.body",
  },
  agencyBilling: {
    title: "governance.empty.agencyBilling.title",
    body: "governance.empty.agencyBilling.body",
  },
} as const satisfies Record<
  string,
  { title: SimpleMessageKey; body: SimpleMessageKey }
>;

/** The governance surfaces with shared first-run copy. */
export type GovernanceSurface = keyof typeof KEYS;

export const GOVERNANCE_SURFACES = Object.keys(KEYS) as GovernanceSurface[];

export interface GovernanceEmptyCopy {
  title: string;
  description: string;
}

/**
 * First-run copy for a governance surface: what it is for, then what makes a
 * row appear. The return shape is exactly what `<EmptyState>` and
 * `QueryStates`' `empty` prop already take, so adopting it at a call site is a
 * one-line substitution rather than a refactor.
 */
export function governanceEmptyCopy(
  surface: GovernanceSurface,
): GovernanceEmptyCopy {
  return {
    title: msg(KEYS[surface].title),
    description: msg(KEYS[surface].body),
  };
}
