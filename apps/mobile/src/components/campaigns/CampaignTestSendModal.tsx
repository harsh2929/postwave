/**
 * CampaignTestSendModal — send yourself a copy before the real thing.
 *
 * Two fixes:
 *  - NO ACCIDENTAL REPEATS. After the first send resolved, the success banner
 *    appeared and the primary button immediately reactivated as "Send test",
 *    so re-reading the banner and tapping again fired a second real send.
 *    The button now settles into "Sent ✓" for a cooldown, and reactivates
 *    early only when the recipient has actually changed.
 *  - Failures are a toast carrying an actionable message, not an Alert
 *    echoing the transport error.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { useToast } from "@/components/Toast";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import {
  isValidTestEmail,
  useSendTestCampaign,
  type CampaignDetail,
} from "@/hooks/useCampaigns";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { TINT_ALPHA, withAlpha } from "@/lib/color";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";

/** How long the primary button stays settled after a successful test send. */
const RESEND_COOLDOWN_MS = 10_000;

export function CampaignTestSendModal({
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
  const myEmail = useAuthStore((s) => s.session?.email ?? null);
  const [to, setTo] = useState<string>(myEmail ?? "");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const testSend = useSendTestCampaign();

  const clearCooldown = useCallback(() => {
    if (cooldownTimer.current) {
      clearTimeout(cooldownTimer.current);
      cooldownTimer.current = null;
    }
  }, []);

  useEffect(() => clearCooldown, [clearCooldown]);

  useEffect(() => {
    if (visible) {
      setTo(myEmail ?? "");
      setSentTo(null);
      setCooling(false);
      clearCooldown();
    }
  }, [visible, myEmail, clearCooldown]);

  const trimmed = to.trim();
  const valid = isValidTestEmail(trimmed);
  // Editing the recipient is an explicit signal that a second send is
  // intended, so it ends the cooldown early.
  const recipientChanged = sentTo != null && trimmed !== sentTo;
  const settled = cooling && !recipientChanged;

  const handleSend = useCallback(() => {
    if (!valid || settled || testSend.isPending) return;
    testSend.mutate(
      { campaignId: campaign.id, toEmail: trimmed },
      {
        onSuccess: (res) => {
          haptics.success();
          setSentTo(res.to ?? trimmed);
          setCooling(true);
          clearCooldown();
          cooldownTimer.current = setTimeout(() => {
            setCooling(false);
            cooldownTimer.current = null;
          }, RESEND_COOLDOWN_MS);
        },
        onError: (err: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't send the test."),
          });
        },
      },
    );
  }, [valid, settled, testSend, campaign.id, trimmed, clearCooldown, toast]);

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <ModalHeader title="Send test" onClose={onClose} />

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontSize: 13,
          marginBottom: 16,
          fontFamily: FONT.regular,
        }}
      >
        Send a one-off copy of{" "}
        {campaign.subject ? `"${campaign.subject}"` : "this draft"} to check how
        it lands in a real inbox before you send for real. The test uses the
        campaign&apos;s saved subject and body.
      </Text>

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          fontSize: 12,
          marginBottom: 6,
          fontFamily: FONT.regular,
        }}
      >
        Send to
      </Text>
      <TextInput
        // Inputs scale with the OS text size but their height does not — cap it.
        {...typeCap("body")}
        value={to}
        onChangeText={setTo}
        placeholder="you@example.com"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Test recipient email address"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        inputMode="email"
        // A one-field form whose keyboard had no verb: the operator typed an
        // address, hit a "return" key that did nothing, dismissed the keyboard
        // and then reached for the button. "Send" on the key cap does what it
        // says, and handleSend already no-ops on an invalid or cooling state,
        // so a premature return is inert rather than an error.
        returnKeyType="send"
        onSubmitEditing={handleSend}
        style={{
          color: t.fg,
          fontSize: 15,
          fontFamily: FONT.regular,
          borderColor: trimmed.length > 0 && !valid ? t.danger : t.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          backgroundColor: t.surface,
        }}
      />
      {myEmail && trimmed !== myEmail ? (
        <Pressable
          onPress={() => setTo(myEmail)}
          accessibilityRole="button"
          accessibilityLabel="Send to myself"
          hitSlop={6}
          style={{ marginTop: 8, alignSelf: "flex-start" }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              fontSize: 12,
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Send to myself ({myEmail})
          </Text>
        </Pressable>
      ) : null}
      {trimmed.length > 0 && !valid ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            fontSize: 11,
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          That doesn&apos;t look like a valid email address.
        </Text>
      ) : null}

      {sentTo ? (
        <View
          accessibilityRole="alert"
          style={{
            marginTop: 16,
            backgroundColor: withAlpha(t.success, TINT_ALPHA),
            borderColor: t.success,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.success,
              fontSize: 13,
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Test sent to {sentTo}. Check that inbox.
          </Text>
        </View>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 20,
        }}
      >
        <ActionButton
          label={sentTo ? "Done" : "Cancel"}
          onPress={onClose}
          disabled={testSend.isPending}
        />
        <ActionButton
          label={
            testSend.isPending
              ? "Sending…"
              : settled
                ? "Sent ✓"
                : recipientChanged
                  ? "Send another test"
                  : "Send test"
          }
          primary
          onPress={handleSend}
          disabled={testSend.isPending || !valid || settled}
        />
      </View>
    </KeyboardFormSheet>
  );
}
