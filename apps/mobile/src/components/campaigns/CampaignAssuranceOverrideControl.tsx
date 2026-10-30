import { useEffect, useState } from "react";
import type {
  CampaignAssuranceFinding,
  CampaignAssuranceOverride,
} from "@postwave/sdk";
import { Pressable, Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  ModalHeader,
  SubActionButton,
} from "@/components/subscriber/SubActionButton";
import { BodyText } from "@/components/campaigns/CampaignAssurancePrimitives";
import {
  assuranceOverrideAvailability,
  normalizeAssuranceOverrideReason,
} from "@/lib/campaignAssuranceOverride";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardDismiss } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface MobileAssuranceOverrideDraft {
  decision: "allow_send" | "reject";
  reason: string;
}

export function CampaignAssuranceFindingGovernance({
  finding,
  existingOverride,
  effectiveRole,
  online,
  onOpen,
}: {
  finding: CampaignAssuranceFinding;
  existingOverride: CampaignAssuranceOverride | undefined;
  effectiveRole: string | null;
  online: boolean;
  onOpen: () => void;
}) {
  const { t } = useTheme();
  const availability = assuranceOverrideAvailability({
    overridable: finding.overridable,
    existingOverride,
    effectiveRole,
    online,
  });

  if (availability === "existing_receipt" && existingOverride) {
    return (
      <View
        accessibilityLabel={`Governed decision: ${existingOverride.decision}; rationale: ${existingOverride.reason}`}
        style={{ gap: 2 }}
      >
        <BodyText color={t.fgMuted}>
          Governed{" "}
          {existingOverride.decision === "allow_send" ? "waiver" : "rejection"}:{" "}
          {existingOverride.reason}
        </BodyText>
        <BodyText color={t.fgSubtle}>
          Immutable decision receipt recorded {existingOverride.created_at}.
        </BodyText>
      </View>
    );
  }
  if (availability === "policy_blocked") {
    return (
      <BodyText color={t.fgSubtle}>
        Policy marks this finding non-overridable. Resolve it on web or desktop,
        then run Campaign Assurance again.
      </BodyText>
    );
  }
  if (availability === "role_handoff") {
    return (
      <BodyText color={t.fgSubtle}>
        Only a workspace owner or admin may record a governed decision. Review
        remains available here.
      </BodyText>
    );
  }
  if (availability === "offline_handoff") {
    return (
      <BodyText color={t.fgSubtle}>
        Reconnect before recording a governed decision. No offline waiver is
        inferred or queued.
      </BodyText>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Record governed decision for ${finding.code}`}
      onPress={() => {
        haptics.tap();
        onOpen();
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
        Record governed decision
      </Text>
    </Pressable>
  );
}

export function CampaignAssuranceOverrideSheet({
  finding,
  busy,
  submitError,
  onClose,
  onSubmit,
}: {
  finding: CampaignAssuranceFinding | null;
  busy: boolean;
  submitError: string | null;
  onClose: () => void;
  onSubmit: (draft: MobileAssuranceOverrideDraft) => void;
}) {
  const { t } = useTheme();
  const [decision, setDecision] = useState<"allow_send" | "reject">(
    "allow_send",
  );
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const findingId = finding?.id;

  useEffect(() => {
    if (!findingId) return;
    setDecision("allow_send");
    setReason("");
    setAttempted(false);
  }, [findingId]);

  let reasonProblem: string | null = null;
  try {
    normalizeAssuranceOverrideReason(reason);
  } catch (error) {
    reasonProblem =
      error instanceof Error ? error.message : "A rationale is required.";
  }

  return (
    <KeyboardFormSheet
      visible={finding !== null}
      onClose={onClose}
      accessibilityLabel="Govern Campaign Assurance finding"
    >
      <ModalHeader
        title={finding ? `Govern ${finding.code}` : "Govern finding"}
        onClose={onClose}
        t={t}
      />
      <BodyText color={t.fgMuted}>
        This appends an immutable, finding-scoped decision. It does not edit the
        campaign, erase the finding, or bypass the server&apos;s send-time
        identity checks.
      </BodyText>

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.medium,
          marginBottom: 6,
          marginTop: 14,
        }}
      >
        Decision
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Chip
          label="Allow this exact frozen send"
          active={decision === "allow_send"}
          disabled={busy}
          onPress={() => setDecision("allow_send")}
        />
        <Chip
          label="Reject this appeal"
          active={decision === "reject"}
          disabled={busy}
          onPress={() => setDecision("reject")}
        />
      </View>

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.medium,
          marginBottom: 6,
          marginTop: 14,
        }}
      >
        Required rationale
      </Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        editable={!busy}
        maxLength={2_000}
        multiline
        accessibilityLabel="Governed decision rationale"
        placeholder="Explain why this exact finding is acceptable or must remain blocked."
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="sentences"
        autoCorrect={false}
        {...keyboardDismiss()}
        {...typeCap("body")}
        style={{
          color: t.fg,
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          minHeight: 88,
          textAlignVertical: "top",
          fontFamily: FONT.regular,
          fontSize: fontSizeFor("body"),
        }}
      />
      <BodyText color={t.fgSubtle}>
        {Array.from(reason.trim()).length}/2000 · minimum 10
      </BodyText>

      {attempted && reasonProblem ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityRole="alert"
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            marginTop: 8,
          }}
        >
          {reasonProblem}
        </Text>
      ) : null}
      {submitError ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityRole="alert"
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            marginTop: 8,
          }}
        >
          {submitError}
        </Text>
      ) : null}

      <View style={{ marginTop: 14 }}>
        <SubActionButton
          label={busy ? "Recording…" : "Record immutable decision"}
          busy={busy}
          disabled={busy}
          t={t}
          onPress={() => {
            setAttempted(true);
            if (reasonProblem || busy) return;
            onSubmit({ decision, reason: reason.trim() });
          }}
        />
      </View>
    </KeyboardFormSheet>
  );
}
