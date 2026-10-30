/**
 * ListMembershipActions — the "Add members" affordance above the roster, and
 * the one sentence that says the remove action exists.
 *
 * Withholding rules, in the order they are decided (the ListManageActions
 * idiom, and the same house rule):
 *
 *  - BELOW EDITOR the card renders ONE caption instead of controls. Both
 *    membership routes are editor-floor in the routeauth manifest, so a
 *    disabled button would advertise an affordance the role cannot use.
 *  - OFFLINE / GATED it renders nothing. Unlike the person-side add — which is
 *    queueable precisely because the list was already chosen — you cannot pick
 *    who to add without the live candidate search, so there is nothing
 *    truthful to queue and the parent's gate notice already explains the state.
 *
 * Unlike ListManageActions this does NOT require the Listmonk bigint id: both
 * membership routes resolve a Moosewave uuid as well (resolveListUUID,
 * apps/api/internal/lists/members.go:245), so a uuid deep link can still edit
 * membership.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { ListAddMembersSheet } from "@/components/lists/ListAddMembersSheet";
import { useCanEditMembership } from "@/hooks/useListMembership";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  addMembersToastCopy,
  LIST_MEMBERSHIP_ROLE_CAPTION,
} from "@/lib/listMembershipRows";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ListMembershipActions({
  listId,
  listName,
  blocked,
}: {
  listId: string;
  listName: string;
  /** The online gate is closed — the screen already says why. */
  blocked: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const canEdit = useCanEditMembership();
  const [open, setOpen] = useState(false);

  if (!canEdit) {
    return (
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          marginBottom: 10,
        }}
      >
        {LIST_MEMBERSHIP_ROLE_CAPTION}
      </Text>
    );
  }

  if (blocked) return null;

  return (
    <View style={{ marginBottom: 10, gap: 6 }}>
      <Pressable
        onPress={() => {
          haptics.tap();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={`Add members to ${listName}`}
        style={{
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.accent,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          Add members
        </Text>
      </Pressable>
      {/* The swipe is invisible, so it is stated once rather than discovered.
          VoiceOver reaches the same action through the rotor. */}
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        Swipe a member row to take them off this list.
      </Text>

      <ListAddMembersSheet
        visible={open}
        listId={listId}
        listName={listName}
        onClose={() => setOpen(false)}
        onAdded={(result) => {
          const copy = addMembersToastCopy(listName, result);
          if (copy.kind === "success") haptics.success();
          toast(copy);
        }}
      />
    </View>
  );
}
