/**
 * InvoiceSection — the last few invoices, with a one-tap open and a
 * long-press forward.
 *
 * "Send me last month's invoice" is a thing people are asked away from a desk.
 * The hosted invoice page opens fine in mobile Safari, so the phone's job is to
 * find the row and hand off the link — not to render a PDF.
 *
 * Every URL goes through `safeBillingRedirectURL` before it reaches
 * `Linking.openURL`: the response body is trusted for its content, never for
 * where it points. A row whose link fails that check stays visible (so the
 * amount and status are still readable) but is not tappable, and says why.
 */
import * as Linking from "expo-linking";
import { Pressable, Share, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { useToast } from "@/components/Toast";
import type { BillingInvoice } from "@/api/billing";
import { safeBillingRedirectURL } from "@/lib/billingNormalize";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface InvoiceSectionProps {
  invoices: readonly BillingInvoice[];
  baseUrl: string | null;
  /** How many rows to show before deferring the rest to the web app. */
  limit?: number;
  /**
   * True when the invoices READ failed. Without it a 500 and a workspace that
   * has never been billed both rendered as nothing at all — see below.
   */
  failed?: boolean;
  /** Retry for the failed case. Absent when the caller has nothing to re-run. */
  onRetry?: (() => void) | undefined;
}

export function InvoiceSection({
  invoices,
  baseUrl,
  limit = 5,
  failed = false,
  onRetry,
}: InvoiceSectionProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const rows = invoices.slice(0, limit);

  /**
   * ERROR BEFORE EMPTY, in the one shape this section can express it.
   *
   * Zero rows used to `return null` unconditionally, so a failed
   * GET /api/v1/billing/invoices DELETED this block — heading, rows and all.
   * That is the "No X yet over a 500" lie told by omission: an operator who
   * opened Plan & usage to forward last month's invoice saw a screen with no
   * invoices section and no reason, and could not tell a broken request from a
   * workspace that has never been billed. The plan and usage reads above
   * already distinguish those two; this one did not.
   *
   * A successful empty read still renders nothing: there is genuinely nothing
   * to report, and a heading over a blank space is noise.
   */
  if (rows.length === 0) {
    if (!failed) return null;
    return (
      <View style={{ marginTop: 24 }}>
        <SectionHeading />
        <ErrorState
          compact
          message="Invoices couldn't be loaded. This is a problem reading the list, not a sign that you have none."
          {...(onRetry ? { onRetry } : {})}
        />
      </View>
    );
  }

  const open = (invoice: BillingInvoice) => {
    const safe = safeBillingRedirectURL(invoice.downloadUrl, baseUrl);
    if (!safe) {
      toast({
        kind: "error",
        message: "That invoice link isn't one we can open safely.",
      });
      return;
    }
    haptics.tap();
    void Linking.openURL(safe).catch(() => {
      toast({ kind: "error", message: "Couldn't open the invoice." });
    });
  };

  const forward = (invoice: BillingInvoice) => {
    const safe = safeBillingRedirectURL(invoice.downloadUrl, baseUrl);
    if (!safe) return;
    haptics.tap();
    void Share.share({
      message: safe,
      title: invoice.number ? `Invoice ${invoice.number}` : "Invoice",
    }).catch(() => undefined);
  };

  return (
    <View style={{ marginTop: 24 }}>
      <SectionHeading />
      {rows.map((invoice) => {
        const openable = safeBillingRedirectURL(invoice.downloadUrl, baseUrl) !== null;
        const label = invoice.number || invoice.id;
        return (
          <Pressable
            key={invoice.id}
            onPress={openable ? () => open(invoice) : undefined}
            onLongPress={openable ? () => forward(invoice) : undefined}
            disabled={!openable}
            accessibilityRole={openable ? "link" : undefined}
            accessibilityLabel={
              openable
                ? `Invoice ${label}, ${invoice.amount}, ${invoice.status}, ${invoice.date}. Opens in your browser. Hold to forward.`
                : `Invoice ${label}, ${invoice.amount}, ${invoice.status}, ${invoice.date}. No link available.`
            }
            style={{
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              marginBottom: 8,
              minHeight: 44,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  fontFamily: FONT.medium,
                  ...typeStyle("body"),
                }}
                numberOfLines={1}
              >
                {invoice.amount || "—"}
              </Text>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgSubtle,
                  fontFamily: FONT.regular,
                  ...typeStyle("bodySmall"),
                  marginTop: 2,
                }}
                numberOfLines={1}
              >
                {[invoice.date, invoice.status].filter(Boolean).join(" · ") || "—"}
              </Text>
            </View>
            {/* Shares the row with the amount block, so it is a DENSE role:
                it cannot reflow without shouldering the amount off-screen. */}
            <Text
              {...typeCap("control")}
              style={{
                color: openable ? t.accent : t.fgSubtle,
                fontFamily: FONT.semibold,
                ...typeStyle("control"),
              }}
            >
              {openable ? "Open" : "No link"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Shared by both branches so the failed case cannot drift off the heading. */
function SectionHeading() {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      {...typeCap("heading")}
      style={{
        color: t.fg,
        fontFamily: FONT.semibold,
        ...typeStyle("heading"),
        marginBottom: 12,
      }}
    >
      Recent invoices
    </Text>
  );
}
