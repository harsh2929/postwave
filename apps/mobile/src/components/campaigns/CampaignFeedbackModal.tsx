/**
 * CampaignFeedbackModal — the review conversation about one campaign.
 *
 * THE GAP THIS CLOSES. Mobile could already approve or reject a send
 * (app/(tabs)/approvals/index.tsx). It could not say why. "Subject is too long" →
 * someone fixes it → resolved is the entire review loop, and it is a loop that
 * happens on a phone more than anywhere else, because the reviewer is the
 * person who is not at their desk.
 *
 * Decisions worth stating:
 *
 *  - OPEN COMMENTS LEAD. `readFeedbackThread` partitions rather than re-sorts,
 *    so the question "what is still outstanding?" is answered at the top of the
 *    sheet instead of three resolved comments down.
 *  - RESOLVED IS NEVER COLOUR-ALONE. A resolved comment is dimmed AND labelled
 *    "Resolved", and its row's spoken label says so.
 *  - THE COMPOSER IS GATED ON WRITE ACCESS, and says why when it is closed.
 *    Reading is read-scope on the gateway; posting and resolving are write-
 *    scope (feedback.go:61-68), so a viewer gets the thread and not the box.
 *  - RESOLVE IS PER-ROW. Only the row being resolved shows progress, so
 *    resolving one comment in a thread of nine does not blank the other eight.
 */
import { useCallback, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { SkeletonCard } from "@/components/Skeleton";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import { useCampaignFeedback } from "@/hooks/useCampaignFeedback";
import {
  feedbackDraftProblem,
  feedbackSummary,
  FEEDBACK_MAX_CHARS,
  type FeedbackRow,
} from "@/lib/campaignFeedback";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface CampaignFeedbackModalProps {
  visible: boolean;
  onClose: () => void;
  campaignId: string;
  /** False for a viewer, offline, or a cached session. */
  canComment: boolean;
  /** Why commenting is unavailable, when it is. */
  blockedReason?: string | undefined;
  returnFocusRef?: ReturnFocusRef | undefined;
}

export function CampaignFeedbackModal({
  visible,
  onClose,
  campaignId,
  returnFocusRef,
  canComment,
  blockedReason,
}: CampaignFeedbackModalProps) {
  const { t } = useTheme();
  const [draft, setDraft] = useState("");
  const state = useCampaignFeedback(campaignId, { enabled: visible });

  const problem = feedbackDraftProblem(draft);
  const handlePost = useCallback(() => {
    if (problem || state.posting) return;
    haptics.tap();
    state.post(draft.trim());
    // Cleared optimistically: the thread refetches on success, and holding the
    // text after a successful post is how a reviewer double-posts a comment.
    setDraft("");
  }, [draft, problem, state]);

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Campaign review comments"
      returnFocusRef={returnFocusRef}
    >
      <ModalHeader title="Comments" onClose={onClose} />

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginBottom: 4,
          fontFamily: FONT.regular,
        }}
      >
        Internal review notes on this campaign. Recipients never see them.
      </Text>
      <Text
        {...typeCap("caption")}
        accessibilityLiveRegion="polite"
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginBottom: 14,
          fontFamily: FONT.medium,
        }}
      >
        {feedbackSummary(state.thread)}
      </Text>

      {canComment ? (
        <View style={{ marginBottom: 16 }}>
          <TextInput
            // Inputs scale with the OS text size but their height does not — cap it.
            {...typeCap("body")}
            value={draft}
            onChangeText={setDraft}
            placeholder="e.g. Subject is too long on mobile — trim to 40 chars"
            placeholderTextColor={t.fgSubtle}
            multiline
            maxLength={FEEDBACK_MAX_CHARS}
            autoCapitalize="sentences"
            accessibilityLabel="New comment"
            style={{
              color: t.fg,
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              minHeight: 88,
              textAlignVertical: "top",
              // No explicit lineHeight on a TextInput: it mis-centres the
              // caret and clips descenders on Android.
              fontSize: typeStyle("body").fontSize,
              fontFamily: FONT.regular,
              writingDirection: "auto",
            }}
          />
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-end",
              marginTop: 8,
            }}
          >
            <ActionButton
              label={state.posting ? "Posting…" : "Post comment"}
              primary
              onPress={handlePost}
              disabled={problem != null || state.posting}
            />
          </View>
          {state.postError ? (
            <ErrorState compact error={state.postError} />
          ) : null}
        </View>
      ) : blockedReason ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            marginBottom: 16,
            fontFamily: FONT.regular,
          }}
        >
          {blockedReason}
        </Text>
      ) : null}

      <FeedbackThread state={state} t={t} canResolve={canComment} />
    </KeyboardFormSheet>
  );
}

function FeedbackThread({
  state,
  t,
  canResolve,
}: {
  state: ReturnType<typeof useCampaignFeedback>;
  t: ThemeTokens;
  canResolve: boolean;
}) {
  if (state.loading) {
    return (
      <View style={{ gap: 10 }}>
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </View>
    );
  }
  if (state.error && state.thread.empty) {
    return <ErrorState error={state.error} onRetry={state.refetch} />;
  }
  if (state.thread.empty) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        No comments yet. Leave the first one — whoever picks this campaign up
        next will see it.
      </Text>
    );
  }
  return (
    <ScrollView
      style={{ maxHeight: 420 }}
      contentContainerStyle={{ gap: 10, paddingBottom: 8 }}
      keyboardShouldPersistTaps="handled"
    >
      {state.resolveError ? (
        <ErrorState compact error={state.resolveError} />
      ) : null}
      {state.thread.rows.map((row) => (
        <FeedbackComment
          key={row.id}
          row={row}
          t={t}
          canResolve={canResolve}
          resolving={state.resolvingId === row.id}
          onResolve={() => state.resolve(row.id)}
        />
      ))}
    </ScrollView>
  );
}

function FeedbackComment({
  row,
  t,
  canResolve,
  resolving,
  onResolve,
}: {
  row: FeedbackRow;
  t: ThemeTokens;
  canResolve: boolean;
  resolving: boolean;
  onResolve: () => void;
}) {
  const when = row.createdAt != null ? relativeTime(row.createdAt) : null;
  return (
    <View
      accessible
      // The spoken label carries the resolved state in words — the dimming and
      // the border colour are reinforcement, never the only signal.
      accessibilityLabel={[
        row.author,
        when,
        row.resolved ? "Resolved" : "Open",
        row.body,
      ]
        .filter(Boolean)
        .join(". ")}
      style={{
        backgroundColor: t.surface,
        borderColor: row.resolved ? t.borderSubtle : t.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 4,
        opacity: row.resolved ? 0.65 : 1,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          {row.author}
        </Text>
        {when ? (
          <Text
            {...typeCap("numeric")}
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              color: t.fgSubtle,
              ...typeStyle("numeric"),
              fontFamily: FONT.regular,
            }}
          >
            {when}
          </Text>
        ) : null}
      </View>

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          writingDirection: "auto",
        }}
      >
        {row.body}
      </Text>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 4,
        }}
      >
        <Text
          {...typeCap("caption")}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            color: row.resolved ? t.fgSubtle : t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.medium,
          }}
        >
          {row.resolved
            ? row.resolvedAt != null
              ? `Resolved ${relativeTime(row.resolvedAt)}`
              : "Resolved"
            : "Open"}
        </Text>
        {!row.resolved && canResolve ? (
          <ActionButton
            label={resolving ? "Resolving…" : "Resolve"}
            onPress={onResolve}
            disabled={resolving}
          />
        ) : null}
      </View>
    </View>
  );
}
