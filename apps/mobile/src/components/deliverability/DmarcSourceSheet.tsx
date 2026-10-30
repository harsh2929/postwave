/**
 * DmarcSourceSheet — one failing source, opened.
 *
 * The insights card names the top failing source IPs; this sheet is the read
 * that lets an operator JUDGE one: total volume, DKIM/SPF pass counts,
 * alignment, primary disposition, and the newest per-report slices. That is
 * the evidence that separates a forwarder (volume steady, DKIM passing,
 * alignment failing) from spoofing (nothing passes anywhere).
 *
 * The detail read (viewer) runs only while the sheet is up — the list never
 * fans out a request per row.
 */
import { Text, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { OpsAction, OpsCardBody } from "@/components/deliverability/OpsCard";
import { Pill } from "@/components/Pill";
import { useDmarcSourceDetail } from "@/hooks/useDmarcSourceDetail";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { num, percent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DmarcSourceSheetProps {
  /** Empty string keeps the sheet closed. */
  ip: string;
  days: number;
  domain: string;
  onClose: () => void;
}

export function DmarcSourceSheet({ ip, days, domain, onClose }: DmarcSourceSheetProps) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const query = useDmarcSourceDetail({
    ip,
    days,
    ...(domain ? { domain } : {}),
  });
  const offline = !gate.enabled;
  const detail = query.data;

  const heading = (text: string) => (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.bold,
        letterSpacing: 0.6,
        textTransform: "uppercase",
      }}
    >
      {text}
    </Text>
  );

  return (
    <KeyboardFormSheet
      visible={ip.length > 0}
      onClose={onClose}
      accessibilityLabel={`DMARC source ${ip}`}
    >
      <View style={{ gap: 10 }}>
        <Text
          {...typeCap("title")}
          style={{
            color: t.fg,
            ...typeStyle("title"),
            fontFamily: FONT.bold,
          }}
        >
          {ip}
        </Text>
        <OpsCardBody>
          {`Last ${days} days${domain ? ` · ${domain}` : " · all domains"}`}
        </OpsCardBody>
        {offline ? (
          <OpsCardBody>Source detail can&apos;t be read offline.</OpsCardBody>
        ) : query.isError ? (
          <OpsCardBody role="alert">
            The source detail couldn&apos;t be loaded.
          </OpsCardBody>
        ) : !detail ? (
          <OpsCardBody>Loading the source detail…</OpsCardBody>
        ) : (
          <>
            {heading("Summary")}
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              <Pill label={`${num(detail.summary.messages)} msgs`} tone="neutral" />
              <Pill
                label={`${percent(detail.summary.alignedPct / 100, { digits: 0 })} aligned`}
                tone={detail.summary.alignedPct >= 90 ? "success" : "danger"}
              />
              <Pill
                label={`disposition ${detail.summary.primaryDisposition}`}
                tone={
                  detail.summary.primaryDisposition === "none"
                    ? "success"
                    : "warning"
                }
              />
            </View>
            <OpsCardBody>
              {`DKIM passed on ${num(detail.summary.dkimPass)} and SPF on ${num(detail.summary.spfPass)} of ${num(detail.summary.messages)} messages. Passing DKIM with failing alignment usually means a forwarder; nothing passing anywhere points at spoofing.`}
            </OpsCardBody>
            {detail.perReport.length > 0 ? heading("Newest reports") : null}
            {detail.perReport.slice(0, 8).map((slice) => (
              <View
                key={`${slice.reportId}-${slice.dateBegin}`}
                accessible
                accessibilityLabel={`${slice.orgName || "Unknown reporter"}, ${num(slice.messages)} messages, ${percent(slice.alignedPct / 100, { digits: 0 })} aligned, ${slice.primaryDisposition}`}
                style={{
                  borderTopColor: t.borderSubtle,
                  borderTopWidth: 1,
                  paddingTop: 8,
                  gap: 2,
                }}
              >
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.medium,
                  }}
                  numberOfLines={1}
                >
                  {slice.orgName || "Unknown reporter"}
                </Text>
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {`${num(slice.messages)} msgs · ${percent(slice.alignedPct / 100, { digits: 0 })} aligned · ${slice.primaryDisposition}`}
                </Text>
              </View>
            ))}
            {detail.hasMore ? (
              <OpsCardBody>
                More reports exist than are shown here — the full archive is on
                the DMARC screen&apos;s report list.
              </OpsCardBody>
            ) : null}
          </>
        )}
        <OpsAction label="Close" onPress={onClose} accessibilityLabel="Close source detail" />
      </View>
    </KeyboardFormSheet>
  );
}
