/**
 * MappingEditSheet — create or edit one SCIM role mapping (IdP group →
 * workspace role), the phone half of desktop's scimRoleMappingUpsert.
 *
 * The server upserts on (tenant, group_name), so "edit" that renames the
 * group is really "create another rule" — the sheet says so the moment the
 * name diverges (SCIM_RENAME_NOTICE) instead of letting the operator find
 * the stale rule at the next access review.
 *
 * An owner/admin grant states its blast radius above the button: the whole
 * IdP group, at each member's next SSO sign-in.
 *
 * ONLINE-ONLY (see api/scimMappings.ts). NativeWind v4: static styles only.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Chip } from "@/components/Chip";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { useToast } from "@/components/Toast";
import { settingsInputStyle } from "@/components/settings/FormControls";
import { useUpsertScimMapping } from "@/hooks/useScimMappingOps";
import {
  SCIM_MAPPING_ROLES,
  SCIM_RENAME_NOTICE,
  scimMappingIssue,
  scimMappingPrecedence,
  scimUpsertConsequence,
} from "@/lib/scimMappingPolicy";
import { liveRegionProps, useAnnounceOnChange } from "@/lib/a11y";
import { transitionLabel } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface MappingEditSheetProps {
  visible: boolean;
  onClose: () => void;
  /** null = creating a new mapping. */
  initial: { groupName: string; role: string; precedence: number } | null;
}

export function MappingEditSheet({
  visible,
  onClose,
  initial,
}: MappingEditSheetProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const upsert = useUpsertScimMapping();
  const [groupName, setGroupName] = useState("");
  const [role, setRole] = useState("viewer");
  const [precedence, setPrecedence] = useState("100");
  const [issue, setIssue] = useState<string | null>(null);
  // The issue line's alert role and live region are Android's; VoiceOver on
  // iOS hears only this.
  useAnnounceOnChange(issue);
  // The return key walks the two text fields; the role chips are not fields.
  const precedenceRef = useRef<TextInput>(null);

  // Re-seed the form each time the sheet opens for a (possibly different) row.
  useEffect(() => {
    if (!visible) return;
    setGroupName(initial?.groupName ?? "");
    setRole(initial?.role ?? "viewer");
    setPrecedence(String(initial?.precedence ?? 100));
    setIssue(null);
  }, [visible, initial]);

  const draft = { groupName, role, precedence };
  const renamed =
    initial !== null && groupName.trim() !== initial.groupName.trim();
  const consequence = scimUpsertConsequence(draft);
  const busy = upsert.isPending;

  const onSave = () => {
    const problem = scimMappingIssue(draft);
    if (problem) {
      setIssue(problem);
      return;
    }
    setIssue(null);
    haptics.tap();
    upsert.mutate(
      {
        groupName: groupName.trim(),
        role,
        precedence: scimMappingPrecedence(draft),
      },
      {
        onSuccess: (saved) => {
          toast({
            kind: "success",
            message: `Mapping saved: ${transitionLabel(
              saved.groupName || groupName.trim(),
              saved.role,
            )}.`,
          });
          onClose();
        },
        onError: (err) => {
          setIssue(
            (err as { status?: number }).status === 403
              ? "Only an owner or admin can change role mappings."
              : (err as Error).message || "The mapping could not be saved.",
          );
        },
      },
    );
  };

  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text
            {...typeCap("title")}
            accessibilityRole="header"
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.semibold,
              marginBottom: 4,
            }}
          >
            {initial ? "Edit role mapping" : "New role mapping"}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginBottom: 16,
            }}
          >
            Lowest precedence wins when a user is in several mapped groups.
            “*” is the catch-all for users in no mapped group.
          </Text>

          <TextInput
            value={groupName}
            onChangeText={setGroupName}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="IdP group name (or *)"
            placeholderTextColor={t.fgSubtle}
            accessibilityLabel="IdP group name"
            // A TextInput scales with the OS text setting exactly like a Text,
            // and its 44pt minHeight does not, so an uncapped input clips its
            // own caret at accessibility sizes.
            {...typeCap("body")}
            {...keyboardChain({ next: precedenceRef })}
            style={settingsInputStyle(t)}
          />
          {renamed ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 6,
              }}
            >
              {SCIM_RENAME_NOTICE}
            </Text>
          ) : null}

          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 12,
            }}
          >
            {SCIM_MAPPING_ROLES.map((option) => (
              <Chip
                key={option}
                label={option}
                active={role === option}
                onPress={() => setRole(option)}
                accessibilityLabel={`Role ${option}`}
              />
            ))}
          </View>

          <TextInput
            ref={precedenceRef}
            value={precedence}
            onChangeText={setPrecedence}
            keyboardType="number-pad"
            placeholder="Precedence (0–1000, lower wins)"
            placeholderTextColor={t.fgSubtle}
            accessibilityLabel="Precedence, 0 to 1000, lower wins"
            {...typeCap("body")}
            {...keyboardChain({ onSubmit: onSave, disabled: busy })}
            style={{ ...settingsInputStyle(t), marginTop: 12 }}
          />

          {consequence ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.danger,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.medium,
                marginTop: 12,
              }}
            >
              {consequence}
            </Text>
          ) : null}
          {issue ? (
            <Text
              {...liveRegionProps()}
              {...typeCap("caption")}
              style={{
                color: t.danger,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
            >
              {issue}
            </Text>
          ) : null}

          <Pressable
            onPress={onSave}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Save role mapping"
            accessibilityState={{ disabled: busy }}
            style={{
              minHeight: 48,
              justifyContent: "center",
              alignItems: "center",
              borderRadius: 12,
              marginTop: 16,
              backgroundColor: busy ? t.bgSubtle : t.accent,
            }}
          >
            <Text
              {...typeCap("body")}
              style={{
                color: busy ? t.fgMuted : t.accentFg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
            >
              {busy ? "Saving…" : "Save mapping"}
            </Text>
          </Pressable>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close without saving"
            style={{
              minHeight: 44,
              justifyContent: "center",
              alignItems: "center",
              marginTop: 8,
            }}
          >
            <Text
              {...typeCap("body")}
              style={{
                color: t.fgMuted,
                ...typeStyle("body"),
                fontFamily: FONT.medium,
              }}
            >
              Cancel
            </Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
