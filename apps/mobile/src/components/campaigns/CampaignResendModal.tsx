/**
 * CampaignResendModal — the guarded "resend to non-openers" flow.
 *
 * It replaces a two-button Alert that queued the follow-up with NO subject
 * and NO delay, so the clone inherited the parent's exact subject line and
 * went out immediately. Re-mailing the same line to the same inboxes minutes
 * apart is the fastest way to get a sending domain flagged, and desktop's
 * equivalent route refuses it outright (422 `duplicate_subject`) plus floors
 * the send at 24 hours.
 *
 * The rules live in src/lib/campaignResend.ts and are unit-tested there; this
 * sheet is the surface for them.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";

import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import { CampaignFieldInput } from "@/components/campaigns/CampaignFieldInput";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import {
  resendSummaryMessage,
  useResendToNonOpeners,
  type CampaignDetail,
} from "@/hooks/useCampaigns";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  MIN_RESEND_HOURS,
  RESEND_SUBJECT_MAX,
  defaultResendSubject,
  earliestResendAt,
  resendPlan,
  resendTimingLabel,
  validateResendSubject,
} from "@/lib/campaignResend";
import { dateTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";

type Timing = "delayed" | "now";

export function CampaignResendModal({
  visible,
  onClose,
  campaign,
  returnFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  campaign: CampaignDetail;
  returnFocusRef?: ReturnFocusRef | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const resendMutation = useResendToNonOpeners();
  const original = campaign.subject ?? campaign.name ?? "";

  const [subject, setSubject] = useState(() => defaultResendSubject(original));
  const [timing, setTiming] = useState<Timing>("delayed");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setSubject(defaultResendSubject(original));
    setTiming("delayed");
    setSubmitted(false);
  }, [visible, original]);

  const subjectError = validateResendSubject(subject, original);
  const floor = useMemo(() => earliestResendAt(), []);
  const sendAt = timing === "delayed" ? floor : null;

  const handleSend = useCallback(() => {
    setSubmitted(true);
    if (validateResendSubject(subject, original)) {
      haptics.warning();
      return;
    }
    const plan = resendPlan({
      subject,
      sendAt: timing === "delayed" ? earliestResendAt() : null,
    });
    resendMutation.mutate(
      { campaignId: campaign.id, subject: plan.subject, sendAt: plan.sendAt },
      {
        onSuccess: (res) => {
          haptics.success();
          onClose();
          toast({ kind: "success", message: resendSummaryMessage(res) });
        },
        onError: (err: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't queue the resend."),
          });
        },
      },
    );
  }, [campaign.id, onClose, original, resendMutation, subject, timing, toast]);

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Resend to non-openers"
      returnFocusRef={returnFocusRef}
    >
      <ModalHeader title="Resend to non-openers" onClose={onClose} />

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontSize: 13,
          lineHeight: 19,
          marginBottom: 14,
          fontFamily: FONT.regular,
        }}
      >
        This clones the campaign and queues a follow-up to everyone who received
        the original but didn&apos;t open it. Give it a different subject line —
        repeating the original to the same inboxes is what gets a sending domain
        flagged.
      </Text>

      <CampaignFieldInput
        label="Follow-up subject"
        value={subject}
        onChangeText={setSubject}
        placeholder={defaultResendSubject(original) || "A fresh subject line"}
        maxLength={RESEND_SUBJECT_MAX}
        multiline
        {...(submitted && subjectError
          ? { error: subjectError }
          : { hint: `Original: ${original || "—"}` })}
      />

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          fontSize: 12,
          marginBottom: 6,
          fontFamily: FONT.regular,
        }}
      >
        When it goes out
      </Text>
      <SegmentedControl<Timing>
        options={[
          { value: "delayed", label: `In ${MIN_RESEND_HOURS}h` },
          { value: "now", label: "As soon as possible" },
        ]}
        value={timing}
        onChange={setTiming}
        accessibilityLabel="Follow-up send timing"
      />
      <Text
        {...typeCap("caption")}
        style={{
          color: timing === "now" ? t.warning : t.fgSubtle,
          fontSize: 11,
          lineHeight: 16,
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
      >
        {resendTimingLabel(sendAt)}
        {sendAt ? ` (${dateTime(sendAt)})` : ""}
      </Text>

      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 20,
        }}
      >
        <ActionButton
          label="Cancel"
          onPress={onClose}
          disabled={resendMutation.isPending}
        />
        <ActionButton
          label={resendMutation.isPending ? "Queuing…" : "Queue follow-up"}
          primary
          onPress={handleSend}
          disabled={resendMutation.isPending || subjectError != null}
        />
      </View>
    </KeyboardFormSheet>
  );
}
