/**
 * FlowReviewsLink — the pointer from the Approvals queue to the OTHER queue.
 *
 * Moosewave has two human gates, on two endpoints, with two different
 * permission models, and until now the phone told you about one of them:
 *
 *   GET /api/v1/approvals               requireAdmin  → owner|admin only
 *   GET /api/v1/flow-builder/approvals  RequireScope(read:campaigns) → any
 *                                       authenticated user; DECIDING needs
 *                                       write:campaigns, which
 *                                       `sessionRoleAllowsScopes` admits for
 *                                       EDITOR as well (editorWriteScopes,
 *                                       apikeys/middleware.go:287-291).
 *
 * SO WHY A LINK AND NOT A MERGED LIST — this is the whole design decision.
 *
 * Fanning the flow-builder reviews into this screen's rows was the obvious
 * move and it is the wrong one, because the screen ITSELF is admin-gated: an
 * editor, who is exactly the person the flow-review route lets decide, hits
 * the "Approvals need an admin role" notice and returns early. Merging would
 * therefore file the editor's own reviews behind a wall the server never
 * asked for — hiding a capability from the only people who hold it, which is
 * strictly worse than the status quo.
 *
 * The two queues also do not share a shape: an approvals row carries an
 * expiry, an escalation policy, a content hash and a self-approval rule; a
 * flow review carries a node id and an automation id it cannot even resolve
 * to a flow name (see lib/flowApprovals fact 2). One list of both would have
 * to lie about one of them.
 *
 * So: this screen keeps its own queue, and points — for admins AND, crucially,
 * inside the scope-notice branch, for the editors who can actually act.
 */
import { router } from "expo-router";
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface FlowReviewsLinkProps {
  /** Decidable in-flow reviews, or null while unknown. */
  count: number | null;
}

export function FlowReviewsLink({ count }: FlowReviewsLinkProps) {
  const { t } = useTheme();
  // Absence is not zero: an unresolved or gated query must not render "0 flow
  // reviews waiting", which on a governance surface is an all-clear.
  if (count === null || count <= 0) return null;
  const noun = count === 1 ? "flow review" : "flow reviews";
  return (
    <Pressable
      onPress={() => router.push("/(tabs)/flows")}
      accessibilityRole="button"
      accessibilityLabel={`${count} in-flow ${noun} waiting. Opens Flows, where they are decided.`}
      style={{
        minHeight: 44,
        justifyContent: "center",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surface,
        paddingHorizontal: 14,
        paddingVertical: 10,
        gap: 2,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {`${count} ${noun} waiting in Flows`}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        In-flow manual reviews are a separate queue — editors can decide those
        even without an admin role.
      </Text>
    </Pressable>
  );
}
