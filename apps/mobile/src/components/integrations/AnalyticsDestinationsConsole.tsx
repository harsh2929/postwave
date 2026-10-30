/**
 * AnalyticsDestinationsConsole — the analytics / CDP destinations (Segment,
 * RudderStack, GA-class) as a monitoring slice on the integrations tab.
 *
 * Register: "cannot see whether a connected analytics destination is failing,
 * nor pause a misbehaving one, from the phone". The rows, verbs and run
 * history come from the generic family panel — GET /api/v1/analytics-integrations
 * (viewer), sync / backfill / pause (admin), DELETE (admin), GET /{id}/runs
 * (viewer); analytics_integrations/handlers.go:190-199. What this slice adds
 * is the roll-up under the family label — "3 destinations · 1 failing ·
 * 1 paused" — so the answer to "is anything failing" is readable before the
 * rows are.
 *
 * The counts are the family list's own rows, tallied: nothing is fetched
 * twice (same query key as the panel), and nothing is rendered when the list
 * is not a fact — a failed read shows the panel's failure notice and no
 * numbers, and an empty family renders nothing, like its siblings.
 *
 * "Sync now" posts an empty body, which makes the server pull from the
 * provider (handlers.go `sync`: `providerPullWithRetry`); where no puller is
 * wired the server answers 422 payload_required with a sentence, and the panel
 * shows that sentence verbatim rather than "something went wrong".
 *
 * No resume: analytics-integrations has no resume route (manifest and
 * handlers), and desktop's api layer has none either — the register's
 * "pause/resume" over-claims. The panel's verb policy never invents one.
 */
import { ConnectionFamilyPanel } from "@/components/integrations/ConnectionFamilyPanel";
import { useConnectionFamily } from "@/hooks/useConnectionFamily";
import { connectionRollup, rollupSentence } from "@/lib/connectionRowState";

export function AnalyticsDestinationsConsole() {
  const query = useConnectionFamily("analytics");
  const summary = query.isError
    ? ""
    : rollupSentence(connectionRollup(query.data), "destination");
  return (
    <ConnectionFamilyPanel
      family="analytics"
      {...(summary ? { summary } : {})}
    />
  );
}
