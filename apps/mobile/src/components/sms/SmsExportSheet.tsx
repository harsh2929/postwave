/**
 * SmsExportSheet — the audited SMS conversations CSV export, phone form.
 *
 * The server gates the export on a recorded audit reason and answers with
 * truth headers; this sheet collects the reason, runs the fetch, hands the
 * CSV TEXT to the system share sheet (this app deliberately ships no
 * filesystem/share-file dependency), and then shows the server-bounds receipt
 * verbatim — including the truncation warning when the 10k cap cut it short.
 */
import { useRef, useState } from "react";
import { Pressable, Share, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { exportSmsConversationsCsv } from "@/api/smsConversationsExport";
import type { SmsInboxAccess } from "@/hooks/useSmsInbox";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import { smsExportReasonError, smsExportReceiptLine } from "@/lib/smsExport";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export function SmsExportSheet({
  visible,
  access,
  onClose,
}: {
  visible: boolean;
  access: SmsInboxAccess;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runningRef = useRef(false);

  const submit = () => {
    const invalid = smsExportReasonError(reason);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (runningRef.current || !access.canRequest) return;
    runningRef.current = true;
    setBusy(true);
    setError(null);
    setReceipt(null);
    void (async () => {
      try {
        const result = await exportSmsConversationsCsv({ reason });
        haptics.success();
        setReceipt(smsExportReceiptLine(result.truth));
        await Share.share(
          { message: result.csv, title: result.filename },
          { subject: result.filename },
        );
      } catch (failure) {
        haptics.error();
        setError(
          failure instanceof Error
            ? failure.message
            : "The export failed. Nothing was shared.",
        );
      } finally {
        runningRef.current = false;
        setBusy(false);
      }
    })();
  };

  const caption = (text: string, tone: "muted" | "danger" | "ok" = "muted") => (
    <Text
      accessibilityLiveRegion="polite"
      {...typeCap("caption")}
      style={{
        color:
          tone === "danger" ? t.danger : tone === "ok" ? t.fg : t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.medium,
      }}
    >
      {text}
    </Text>
  );

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={() => {
        setReason("");
        setError(null);
        setReceipt(null);
        onClose();
      }}
      accessibilityLabel="Export SMS conversations"
    >
      <View style={{ gap: 8 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
          }}
        >
          Export conversations (CSV)
        </Text>
        {caption(
          "A tenant-wide summary (phone, last message time, message count) capped at 10,000 rows by the server. The reason below is recorded in the audit log with the export.",
        )}
        {/* The only field in the sheet, so the return key IS the run button.
            `submit` already re-validates and no-ops while an export is in
            flight, so it stays wired rather than disabled — a return press on
            an empty reason should say what is wrong. */}
        <TextInput
          value={reason}
          onChangeText={(next) => {
            setReason(next);
            setError(null);
          }}
          placeholder="Audit reason (required, recorded)"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Audit reason for the export"
          {...typeCap("bodySmall")}
          {...keyboardChain({ onSubmit: submit })}
          style={{
            color: t.fg,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontFamily: FONT.regular,
            fontSize: fontSizeFor("bodySmall"),
            minHeight: 40,
          }}
        />
        <Pressable
          onPress={submit}
          disabled={busy || !access.canRequest}
          accessibilityRole="button"
          accessibilityLabel="Run the audited export and open the share sheet"
          accessibilityState={{ disabled: busy || !access.canRequest }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: busy || !access.canRequest ? t.fgMuted : t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {busy ? "Exporting…" : "Export and share"}
          </Text>
        </Pressable>
        {receipt ? caption(receipt, "ok") : null}
        {error ? caption(error, "danger") : null}
      </View>
    </KeyboardFormSheet>
  );
}
