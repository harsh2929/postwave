/**
 * IncidentRegisterEmpty — the register's list-empty slot.
 *
 * Split out of PrivacyIncidentsScreen with no change of behaviour. It carries
 * the distinction the whole surface is built around: a server REFUSAL, a
 * failed read, an offline device, and a genuinely empty register look alike in
 * a list and mean entirely different things.
 *
 * The `forbidden` branch is first and says so in words — "this is not a claim
 * that the register is empty" — because a role can change mid-session and a
 * custom role can be granted the admin scope server-side, so a 403 must never
 * be rendered as an all-clear about a breach register.
 */
import { QueryStates } from "@/components/QueryStates";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { SkeletonList } from "@/components/Skeleton";
import type { PrivacyIncidentsScreenController } from "@/hooks/usePrivacyIncidentsScreen";

type Props = Pick<
  PrivacyIncidentsScreenController,
  | "dataState"
  | "forbidden"
  | "incidents"
  | "listFailed"
  | "restoredPageMalformed"
  | "rows"
>;

export function IncidentRegisterEmpty({
  dataState,
  forbidden,
  incidents,
  listFailed,
  restoredPageMalformed,
  rows,
}: Props) {
  if (forbidden) {
    return (
      <MobileScopeNotice
        title="The server refused this read"
        body="Every breach-incident route needs owner or admin. Your role may have changed since you signed in — this is not a claim that the register is empty."
      />
    );
  }
  return (
    <QueryStates
      query={{
        isError: listFailed,
        isLoading:
          incidents.isLoading || (incidents.isFetching && rows.length === 0),
        isPending: incidents.isPending,
        isPaused: incidents.isPaused,
        error: restoredPageMalformed
          ? new Error("The stored incident page is malformed; refresh it.")
          : incidents.error,
        refetch: incidents.refetch,
      }}
      gate={{ enabled: dataState !== "hidden" }}
      isEmpty={rows.length === 0}
      skeleton={
        <SkeletonList rows={4} lines={3} label="Loading breach incidents" />
      }
      offlineMessage="Connect to your workspace to load the breach register. A cached 72-hour countdown of unknown age would be worse than none."
      empty={{
        title: "No breach incidents",
        description:
          "The loaded register contains no incident records. The moment a possible breach is suspected, declare a preliminary record here — that is what starts the operational clock.",
      }}
    >
      {null}
    </QueryStates>
  );
}
