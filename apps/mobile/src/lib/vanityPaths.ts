/**
 * lib/vanityPaths.ts — campaign short addresses (F04), and the caveat that must
 * travel with them.
 *
 * ASSURE#9: web and desktop render this panel; mobile had nothing — including the
 * short-address request count and its mandatory caveat.
 *
 * ── THE CAVEAT IS THE FEATURE ──────────────────────────────────────────────
 * `apps/web/src/lib/vanity-paths.ts:101-111` says why the sentence is defined once
 * and rendered unconditionally: the whole point of F04 is campaign provenance
 * that stays honest about what it does not prove. A surface that shows requests
 * without that boundary is the failure mode the feature was designed to avoid,
 * so the sentence is reproduced
 * here word for word rather than paraphrased for a smaller screen. A shortened
 * caveat is a different claim.
 *
 * Import-free of react-native, so it is node-tested.
 */

/**
 * The audited campaign-linkage register lives in `lib/campaignAttribution.ts`
 * and is re-exported here unchanged: it is the same feature and the same
 * caveat, and callers should not have to know which half a symbol sits in.
 */
export {
  campaignEvidenceOutcomeLabel,
  outcomeVisibilityCaveat,
  parseCampaignDirectAttributionPage,
} from "./campaignAttribution";
export type { CampaignDirectAttributionPage } from "./campaignAttribution";

export interface VanityPath {
  id: string;
  slug: string;
  publicPath: string;
  destinationHost: string;
  destinationPath: string;
  status: string;
}

/**
 * Verbatim from apps/web/src/lib/vanity-paths.ts:105-111.
 *
 * Kept identical across surfaces on purpose: a user who reads it on the web and
 * again on the phone must be told the same thing, and a per-surface rewording is
 * how a legal-ish disclosure drifts into a marketing line.
 */
export function readershipCaveat(): string {
  return (
    "A visit proves only that this address was requested — not that a person " +
    "typed it, arrived, or read the email. Codes and addresses can be forwarded, " +
    "screenshotted, read aloud, crawled, or prefetched. Treat linked outcomes as " +
    "campaign linkage, never proof of human attention or readership."
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseVanityPaths(payload: unknown): VanityPath[] {
  const rows =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).items
      : null;
  if (!Array.isArray(rows)) return [];
  const out: VanityPath[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    const slug = str(row.slug);
    if (!id || !slug) continue;
    out.push({
      id,
      slug,
      // The server sends the public path already built ("/go/" + slug). Prefer it
      // over rebuilding: the prefix is the server's to choose, and a client that
      // reconstructs it will be wrong the day it changes.
      publicPath: str(row.public_path) || `/go/${slug}`,
      destinationHost: str(row.destination_host),
      destinationPath: str(row.destination_path),
      status: str(row.status),
    });
  }
  return out;
}

/** Where a short address actually sends someone. */
export function vanityDestination(path: VanityPath): string {
  if (!path.destinationHost) return "destination not set";
  return `${path.destinationHost}${path.destinationPath}`;
}
