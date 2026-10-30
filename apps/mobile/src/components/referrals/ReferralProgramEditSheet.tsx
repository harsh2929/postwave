/**
 * ReferralProgramEditSheet — create or amend the referral programme from a
 * phone: milestone tiers (count / reward label / kind) and the expiry date.
 *
 * THE SAVE IS A FULL REPLACEMENT with a stale-write precondition, which
 * shapes everything here:
 *  - the body always re-sends the programme's seven stored reward/
 *    verification fields VERBATIM (buildReferralProgramBody spreads
 *    `program.replaceFields`) and each untouched tier's monetary wire fields
 *    ride under the edits — otherwise an innocent label fix would wipe fields
 *    this phone never rendered;
 *  - editing sends `expected_program_id`, creating sends
 *    `expect_no_active_program`; a 409 is the guard WORKING and is worded as
 *    "refresh and re-apply", never as a generic failure.
 *
 * ADMIN and ONLINE-ONLY (POST /referral-programs is r.With(admin), and a
 * queued full-replace built against a stale programme is exactly what the
 * precondition exists to refuse).
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { useToast } from "@/components/Toast";
import {
  TierDraftRow,
  inputStyle,
} from "@/components/referrals/ReferralMilestoneRow";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useSetReferralProgram } from "@/hooks/useReferrals";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  REFERRAL_PROGRAM_CONFLICT_MESSAGE,
  buildReferralProgramBody,
  milestoneDraftsFrom,
  referralExpiryIso,
  validateMilestoneDrafts,
  type MilestoneDraft,
} from "@/lib/referralAdmin";
import type { ReferralProgram } from "@/lib/referrals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ReferralProgramEditSheetProps {
  visible: boolean;
  /** Null = create a first programme; otherwise edit the current one. */
  program: ReferralProgram | null;
  onClose: () => void;
}

const NEW_TIER: MilestoneDraft = { count: "", label: "", kind: "" };


export function ReferralProgramEditSheet(props: ReferralProgramEditSheetProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const online = useIsOnline();
  const save = useSetReferralProgram();

  const [drafts, setDrafts] = useState<MilestoneDraft[]>([NEW_TIER]);
  const [expiry, setExpiry] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  // Re-seed from the CURRENT programme each time the sheet opens: the full-
  // replace body must be built on what is stored now, not on a draft from a
  // previous open.
  useEffect(() => {
    if (!props.visible) return;
    setProblem(null);
    if (props.program) {
      setDrafts(milestoneDraftsFrom(props.program.milestones));
      setExpiry((props.program.expiresAt ?? "").slice(0, 10));
    } else {
      setDrafts([NEW_TIER]);
      setExpiry("");
    }
  }, [props.program, props.visible]);

  const patchDraft = (index: number, patch: Partial<MilestoneDraft>) => {
    setDrafts((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const submit = async () => {
    if (save.isPending) return;
    if (!online) {
      haptics.error();
      toast({
        kind: "error",
        message:
          "Saving the programme needs a connection — a stale queued save is exactly what its own precondition refuses.",
      });
      return;
    }
    const validated = validateMilestoneDrafts(drafts);
    if (!validated.ok) {
      haptics.error();
      setProblem(validated.problem);
      return;
    }
    const expiresAt = referralExpiryIso(expiry);
    if (expiresAt === undefined) {
      haptics.error();
      setProblem("The expiry must be a date like 2026-12-31, or blank for none.");
      return;
    }
    setProblem(null);
    haptics.impact();
    try {
      await save.mutateAsync(
        buildReferralProgramBody(props.program, validated.milestones, expiresAt),
      );
      haptics.success();
      toast({
        kind: "success",
        message: props.program
          ? "Programme updated."
          : "Referral programme created and active.",
      });
      props.onClose();
    } catch (error) {
      haptics.error();
      const status =
        error && typeof error === "object" && "status" in error
          ? (error as { status?: unknown }).status
          : undefined;
      toast({
        kind: "error",
        message:
          status === 409
            ? REFERRAL_PROGRAM_CONFLICT_MESSAGE
            : error instanceof Error && error.message
              ? error.message
              : "Couldn't save the programme. Please try again.",
      });
    }
  };

  return (
    <ReducedMotionModal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomColor: t.borderSubtle,
              borderBottomWidth: 1,
            }}
          >
            <Text
              accessibilityRole="header"
              {...typeCap("title")}
              style={{
                color: t.fg,
                ...typeStyle("title"),
                fontFamily: FONT.display,
              }}
            >
              {props.program ? "Edit programme" : "New programme"}
            </Text>
            <Pressable
              onPress={props.onClose}
              accessibilityRole="button"
              accessibilityLabel="Cancel editing the programme"
              style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.accent,
                  ...typeStyle("callout"),
                  fontFamily: FONT.semibold,
                }}
              >
                Cancel
              </Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 14 }}
            keyboardShouldPersistTaps="handled"
          >
            <Text
              {...typeCap("label")}
              accessibilityRole="header"
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.semibold,
              }}
            >
              Milestone tiers
            </Text>

            {drafts.map((draft, index) => (
              <TierDraftRow
                key={index}
                draft={draft}
                index={index}
                removable={drafts.length > 1}
                onPatch={(patch) => patchDraft(index, patch)}
                onRemove={() =>
                  setDrafts((rows) => rows.filter((_, i) => i !== index))
                }
              />
            ))}

            <Pressable
              onPress={() => setDrafts((rows) => [...rows, NEW_TIER])}
              accessibilityRole="button"
              accessibilityLabel="Add a milestone tier"
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
                Add tier
              </Text>
            </Pressable>

            <Text
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.semibold,
              }}
            >
              Programme expiry
            </Text>
            <TextInput
              value={expiry}
              onChangeText={setExpiry}
              placeholder="YYYY-MM-DD (blank = no expiry)"
              placeholderTextColor={t.fgSubtle}
              accessibilityLabel="Programme expiry date, blank for none"
              returnKeyType="done"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={10}
              {...typeCap("body")}
              style={inputStyle(t.fg, t.surface, t.borderSubtle)}
            />

            {problem ? (
              <Text
                accessibilityLiveRegion="polite"
                {...typeCap("label")}
                style={{
                  color: t.warning,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                }}
              >
                {problem}
              </Text>
            ) : null}

            <Pressable
              onPress={() => void submit()}
              disabled={save.isPending}
              accessibilityRole="button"
              accessibilityLabel="Save the referral programme"
              accessibilityState={{ disabled: save.isPending }}
              style={{
                minHeight: 48,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: t.accent,
                opacity: save.isPending ? 0.45 : 1,
              }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: t.accentFg,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                {save.isPending ? "Saving…" : "Save programme"}
              </Text>
            </Pressable>

            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              Saving replaces the whole programme definition. Referee rewards,
              reward values and the verification window are kept exactly as
              stored — editing those stays in the web or desktop app.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
