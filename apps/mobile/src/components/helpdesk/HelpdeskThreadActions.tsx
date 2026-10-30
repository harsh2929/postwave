/**
 * HelpdeskThreadActions — the two versioned writes a thread offers: change the
 * recorded status, and claim/take over/unassign it.
 *
 * Both are gated on the SAME facts the screen verified — a conversation
 * resource with its current revision, a verified catalog, no other write in
 * flight — because either one without a fresh `etag`/`version` is an
 * unconditioned write. Nothing renders at all until a conversation row exists.
 */
import { Pressable, Text } from "react-native";

import { HelpdeskStatusChips } from "@/components/helpdesk/HelpdeskStatusChips";
import type { HelpdeskThreadController } from "@/hooks/useHelpdeskThreadScreen";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function HelpdeskThreadActions({
  screen,
}: {
  screen: HelpdeskThreadController;
}) {
  const { t } = useTheme();
  const {
    assignment,
    catalogStatuses,
    catalogVerified,
    claimLabel,
    onClaim,
    onStatus,
    requestAccess,
    resource,
    row,
    statusChange,
  } = screen;

  if (!row) return null;

  return (
    <>
      <HelpdeskStatusChips
        statuses={catalogVerified ? catalogStatuses : []}
        value={row.status}
        onSelect={(next) => void onStatus(next)}
        disabled={
          statusChange.isPending ||
          assignment.isPending ||
          !requestAccess.canRequest ||
          !resource ||
          !catalogVerified
        }
        pendingStatus={
          statusChange.isPending
            ? (statusChange.variables?.status ?? null)
            : null
        }
        accessibilityLabel="Change this recorded conversation status"
        actionVerb="Record"
      />
      {claimLabel ? (
        <Pressable
          onPress={() => void onClaim()}
          disabled={
            assignment.isPending ||
            statusChange.isPending ||
            !requestAccess.canRequest ||
            !resource
          }
          accessibilityRole="button"
          accessibilityLabel={claimLabel}
          accessibilityState={{
            disabled:
              assignment.isPending ||
              statusChange.isPending ||
              !requestAccess.canRequest ||
              !resource,
          }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: assignment.isPending ? t.fgSubtle : t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {assignment.isPending ? "Assigning…" : claimLabel}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}
