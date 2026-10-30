/**
 * HelpdeskThreadNotices — the disclosure stack above a Helpdesk thread.
 *
 * Every branch here answers the same question: what could NOT be verified for
 * this conversation. Metadata and its revision, the status catalog, the
 * bounded-history window, and the durable internal-note recovery ledger each
 * fail separately, so each says so separately rather than collapsing into one
 * "something went wrong". Message rows staying visible while a write is held
 * is the deliberate behaviour: history is evidence, assignment and status are
 * not.
 */
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import type { HelpdeskThreadController } from "@/hooks/useHelpdeskThreadScreen";
import { FONT } from "@/lib/fonts";
import { HELPDESK_DELIVERY_NOTE } from "@/lib/helpdesk";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function HelpdeskThreadNotices({
  screen,
}: {
  screen: HelpdeskThreadController;
}) {
  const { t } = useTheme();
  const {
    catalog,
    catalogStatuses,
    conversation,
    intent,
    olderHistoryLoaded,
    requestAccess,
    resource,
    thread,
  } = screen;

  return (
    <>
      <MobileScopeNotice
        title="Recorded state only"
        body={HELPDESK_DELIVERY_NOTE}
      />
      {conversation.isError ? (
        <ErrorState
          compact
          message="Conversation metadata and its current revision could not be verified. Message rows below are bounded history only; assignment, status changes, and notes are held."
          onRetry={() => void conversation.refetch()}
        />
      ) : conversation.isPending ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Verifying conversation metadata and its current revision…
        </Text>
      ) : !resource ? (
        <ErrorState
          compact
          message="No verified conversation metadata or current revision is available. Message rows do not prove current assignment or status."
          onRetry={() => void conversation.refetch()}
        />
      ) : null}
      {catalog.isError ? (
        <ErrorState
          compact
          message="The status catalog could not be verified. Recorded messages remain visible, but status changes are held."
          onRetry={() => void catalog.refetch()}
        />
      ) : catalog.isPending ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Verifying the status catalog…
        </Text>
      ) : catalog.data && catalogStatuses.length === 0 ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          The verified catalog contains no status-change values.
        </Text>
      ) : null}
      {olderHistoryLoaded ? (
        <View
          accessibilityRole="summary"
          style={{
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 12,
            padding: 12,
            gap: 6,
          }}
        >
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Older history is loaded. Automatic latest-window refresh is paused
            so a fresh window is never merged with old cursor pages.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Restart from the latest message window"
            onPress={() => void thread.refreshLatest()}
            disabled={!requestAccess.canRequest || thread.isFetching}
            accessibilityState={{
              disabled: !requestAccess.canRequest || thread.isFetching,
            }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Restart latest window
            </Text>
          </Pressable>
        </View>
      ) : null}
      {intent.status === "current" ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.warning,
            ...typeStyle("caption"),
            fontFamily: FONT.medium,
          }}
        >
          An earlier internal-note request is unresolved. Re-enter its exact
          text to retry the same durable key; different text is blocked.
        </Text>
      ) : null}
      {intent.status === "principal_capacity_reached" ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.warning,
            ...typeStyle("caption"),
            fontFamily: FONT.medium,
          }}
        >
          This account&apos;s bounded recovery allocation is full on this
          device. Reconcile an unresolved internal note from its originating
          thread before recording another one.
        </Text>
      ) : null}
      {intent.status === "device_capacity_reached" ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.warning,
            ...typeStyle("caption"),
            fontFamily: FONT.medium,
          }}
        >
          This device&apos;s bounded recovery ledger is full across signed-in
          accounts. Reconcile an unresolved internal note from its originating
          thread before recording another one.
        </Text>
      ) : null}
    </>
  );
}
