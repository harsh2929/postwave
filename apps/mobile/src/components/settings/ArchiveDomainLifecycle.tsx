/**
 * ArchiveDomainLifecycle — everything on the archive-domain card that only
 * exists once a domain has actually been saved: the DNS records to publish,
 * the CNAME and certificate readings, the live public URL, and the
 * remove-verification verb.
 *
 * Split from ArchiveDomainCard so neither file carries the whole lifecycle
 * plus the query/form half. The card owns the server calls and the draft; this
 * owns the reading of a saved domain. `Caption` and `Action` live here because
 * both halves render them.
 */
import type { ReactNode } from "react";
import { Pressable, Share, Text, View } from "react-native";

import { DnsRecordCard } from "@/components/deliverability/DnsRecordCard";
import {
  archiveCnameSentence,
  archiveDnsRecord,
  archivePublicUrl,
  archiveSslSentence,
  archiveTxtRecord,
  type ArchiveDomainStatus,
} from "@/lib/archiveDomain";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Which write is in flight, so every control disables together. */
export type ArchiveDomainBusy = "save" | "verify" | "remove" | null;


/** Everything that only exists once a domain has actually been saved. */
export function ArchiveDomainLifecycle({
  status,
  busy,
  onVerify,
  onRemove,
}: {
  status: ArchiveDomainStatus;
  busy: ArchiveDomainBusy;
  onVerify: () => void;
  onRemove: () => void;
}) {
  const { t } = useTheme();
  const cname = archiveDnsRecord(status);
  const txt = archiveTxtRecord(status);
  const publicUrl = archivePublicUrl(status);
  const share = (record: { type: string; name: string; value: string }) => {
    void Share.share({
      message: `${record.type} ${record.name}\n${record.value}`,
    }).catch(() => undefined);
  };
  return (
    <View style={{ gap: 10 }}>
      {cname ? (
        <DnsRecordCard
          record={{ type: "CNAME", name: cname.host, value: cname.target }}
          domain={status.domain}
          onShare={share}
        />
      ) : null}
      {txt ? (
        <DnsRecordCard
          record={{ type: "TXT", name: txt.host, value: txt.value }}
          domain={status.domain}
          onShare={share}
        />
      ) : null}

      <View style={{ gap: 4 }}>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
            fontWeight: "600",
          }}
        >
          {`CNAME status: ${status.status}`}
        </Text>
        <Caption>{archiveCnameSentence(status)}</Caption>
      </View>
      <Action
        label={
          busy === "verify"
            ? "Checking…"
            : status.status === "verified"
              ? "Re-check"
              : "Verify"
        }
        accessibilityLabel="Verify the archive domain"
        disabled={busy !== null}
        busy={busy === "verify"}
        onPress={onVerify}
      />

      <View style={{ gap: 4 }}>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
            fontWeight: "600",
          }}
        >
          {`SSL certificate: ${status.sslStatus}`}
        </Text>
        <Caption>{archiveSslSentence(status)}</Caption>
      </View>

      {publicUrl ? (
        <View style={{ gap: 4 }}>
          <Caption>Your audience reads published issues at</Caption>
          <Text
            selectable
            {...typeCap("mono")}
            style={{ fontFamily: "Menlo", ...typeStyle("mono"), color: t.fg }}
          >
            {publicUrl}
          </Text>
        </View>
      ) : null}

      <Action
        label={busy === "remove" ? "Removing…" : "Remove verification"}
        accessibilityLabel="Remove the archive domain verification"
        disabled={busy !== null}
        busy={busy === "remove"}
        tone="danger"
        onPress={onRemove}
      />
      <Caption>
        Removing the verification stops this host serving your archive. The
        CNAME at your DNS provider is untouched, and clearing the domain field
        above is a separate change.
      </Caption>
    </View>
  );
}

export function Caption({ children }: { children: ReactNode }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

export function Action({
  label,
  accessibilityLabel,
  disabled,
  busy,
  tone,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  busy: boolean;
  tone?: "danger";
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, busy }}
      style={{
        minHeight: 44,
        justifyContent: "center",
        alignItems: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: tone === "danger" ? t.danger : t.border,
        backgroundColor: t.surface,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: tone === "danger" ? t.danger : t.fg,
          ...typeStyle("body"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
