/**
 * lib/subjectLabBandit.ts — the lab → bandit handoff rules.
 *
 * Desktop's SubjectLab offers "run bandit" over its top-3 scored variants
 * (useCampaignCreation.ts:402 runBandit). Mobile mirrors that from the score
 * panel's reading: rank the rows exactly as the panel displays them
 * (rankSubjectScoreRows) and take the top three texts.
 *
 * Pure and node-tested; the react half lives in
 * components/voice/SubjectLabBanditRow.tsx.
 */
import { rankSubjectScoreRows, type SubjectScoreRow } from "@/lib/subjectLab";

/** Desktop hands runBandit exactly three; the API floor is two. */
export const BANDIT_VARIANT_TARGET = 3;

/**
 * The top-ranked variant texts to arm the bandit with, or null when the
 * reading cannot make a test (fewer than two distinct scored candidates —
 * a one-arm bandit is just a send).
 */
export function banditVariantsFrom(
  rows: readonly SubjectScoreRow[],
): string[] | null {
  const ranked = rankSubjectScoreRows([...rows]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of ranked) {
    const text = row.text.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length === BANDIT_VARIANT_TARGET) break;
  }
  return out.length >= 2 ? out : null;
}

/** The row's one-line explanation of what a tap will do. */
export function banditRowCaption(variantCount: number): string {
  return `Creates a draft A/B test on this campaign's audience with your top ${variantCount} subject${variantCount === 1 ? "" : "s"}. Traffic shifts toward the winner as opens land (Thompson sampling, 10% explore floor). Nothing sends until you schedule it.`;
}
