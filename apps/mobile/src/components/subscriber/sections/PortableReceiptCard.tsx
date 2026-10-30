/**
 * PortableReceiptCard — "hand this person the document they are owed".
 *
 * THE GAP THIS CLOSES. The profile already shows our internal consent LEDGER
 * (`Consent records`, GET /api/v1/consent/receipts/by-email) — evidence for a
 * dispute, phrased for us. It did not offer the SUBJECT-FACING artefact: the
 * ISO 27560 / Kantara CR v1.1 receipt at
 * `GET /api/v1/subscribers/{id}/consent-receipt.json`
 * (consent_receipt_export.go:75), which is the thing a person exercising a
 * subject-access right actually receives and an identity wallet can ingest.
 * A DSAR arrives with a clock on it; producing the document in the hour it
 * lands is genuinely phone-shaped work even though reviewing a full export is
 * not.
 *
 * WHY THERE IS NO "REQUEST A DSAR FOR THIS PERSON" BUTTON. There is no
 * endpoint that could honour one. `POST /api/v1/privacy/export-requests` takes
 * a body of exactly `{region, notes}` (privacy/handlers.go:41-44) and inserts
 * the lifecycle row with `subject_type` hardcoded to `'tenant_admin'` (:403) —
 * there is no subscriber id and no subject email on that surface at all. A
 * button here would file a tenant-wide request that names nobody while
 * appearing, because of where it sat, to track this person's. The tenant queue
 * stays where it is honest: Settings → Privacy.
 *
 * ADMIN-ONLY, AND ABSENT RATHER THAN DISABLED. The route is
 * `RequireScope(ScopeAdmin)`, which is not in `readOnlyScopes`
 * (apikeys/middleware.go:331-336), so on a session cookie it is a hard
 * owner|admin role check. The caller passes `canReadConsent` and renders
 * nothing at all for anyone else — a permanently-403 button teaches an
 * operator that the app is broken.
 *
 * IT IS NOT FETCHED UNTIL ASKED. The response carries the subject's email and
 * their whole consent history in one body from the EXPORT handler, so opening
 * a profile must not perform it. See `usePortableConsentReceipt`.
 *
 * NativeWind v4: static style objects only.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import {
  Card,
  Label,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import { usePortableConsentReceipt } from "@/hooks/useSubscriberRecordHistory";
import { copyToClipboard } from "@/lib/clipboard";
import { EMDASH, dateTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  receiptFilename,
  receiptSummary,
  type PortableConsentReceipt,
} from "@/lib/portableConsentReceipt";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function PortableReceiptCard({
  subscriberId,
  canReadConsent,
}: {
  subscriberId: string;
  /** canAccessMinimumRole("admin", …) — the export route is admin-scoped. */
  canReadConsent: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const receipt = usePortableConsentReceipt(subscriberId, open);

  const onCopy = useCallback(async () => {
    const document = receipt.data;
    if (!document) return;
    haptics.tap();
    // The WHOLE document, pretty-printed — the point of a portable receipt is
    // that it is portable, so copying a summary of it would defeat the
    // purpose. The filename goes to the toast so the operator knows what to
    // call the attachment they are about to paste it into.
    const ok = await copyToClipboard(JSON.stringify(document, null, 2));
    if (ok) {
      haptics.success();
      toast({
        kind: "success",
        message: `Receipt copied. Save it as ${receiptFilename(document, subscriberId)}.`,
      });
    } else {
      // `copyToClipboard` returns false rather than throwing on a locked
      // pasteboard. Claiming "Copied" there would be a lie the operator only
      // discovers when they paste nothing into a regulator's inbox.
      haptics.error();
      toast({
        kind: "error",
        message: "The clipboard refused the copy. Try again, or use the web admin.",
      });
    }
  }, [receipt.data, subscriberId, toast]);

  if (!canReadConsent) return null;

  return (
    <Card style={{ marginTop: 12 }}>
      <Pressable
        onPress={() => {
          haptics.tap();
          setOpen((value) => !value);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Portable consent receipt"
        accessibilityHint="The ISO 27560 document a subject-access request is answered with"
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 44,
          gap: 12,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label>Portable consent receipt</Label>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 2,
            }}
          >
            Answer a subject-access request
          </Text>
        </View>
        <Text
          allowFontScaling={false}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ color: t.fgMuted, fontFamily: FONT.medium, fontSize: 16 }}
        >
          {open ? "▾" : "▸"}
        </Text>
      </Pressable>

      {open ? (
        <View style={{ marginTop: 12, gap: 10 }}>
          {receipt.isLoading ? (
            <SkeletonList rows={2} lines={2} label="Building the receipt" />
          ) : receipt.isError ? (
            <ErrorState
              error={receipt.error}
              onRetry={() => void receipt.refetch()}
            />
          ) : receipt.data ? (
            <ReceiptBody
              receipt={receipt.data}
              onCopy={() => void onCopy()}
            />
          ) : receipt.isSuccess ? (
            // `parsePortableReceipt` returned null: the server answered, but
            // with a body carrying neither a subject nor a receipt id. Saying
            // so beats rendering an empty compliance document.
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              The server returned no usable receipt for this profile. Generate
              it from the web admin so the failure can be inspected.
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function ReceiptBody({
  receipt,
  onCopy,
}: {
  receipt: PortableConsentReceipt;
  onCopy: () => void;
}) {
  const { t } = useTheme();
  return (
    <>
      <Text
        accessible
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {receiptSummary(receipt)}
      </Text>

      {receipt.purposes.map((purpose) => (
        <View
          key={purpose.purpose}
          accessible
          accessibilityLabel={`${purpose.label}: ${
            purpose.active ? "granted" : "not granted"
          }${purpose.grantedAt ? `, since ${dateTime(purpose.grantedAt)}` : ""}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              flexShrink: 1,
            }}
          >
            {purpose.label}
          </Text>
          {/* Word, not colour: a granted/not-granted distinction carried only
              by a green dot is unreadable to a large share of operators and
              invisible in a screenshot pasted into a ticket. */}
          <Text
            {...typeCap("caption")}
            style={{
              color: purpose.active ? t.fg : t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: purpose.active ? FONT.medium : FONT.regular,
            }}
          >
            {purpose.active
              ? purpose.grantedAt
                ? `Granted ${dateTime(purpose.grantedAt)}`
                : "Granted"
              : "Not granted"}
          </Text>
        </View>
      ))}

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {`${receipt.version || EMDASH} · controller ${receipt.controllerName || EMDASH} · generated ${
          receipt.generatedAt ? dateTime(receipt.generatedAt) : EMDASH
        }`}
      </Text>

      <Pressable
        onPress={onCopy}
        accessibilityRole="button"
        accessibilityLabel="Copy the full consent receipt"
        accessibilityHint="Copies the whole ISO 27560 document as JSON"
        style={{
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.borderSubtle,
          backgroundColor: t.surfaceElevated,
          paddingHorizontal: 16,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.medium,
          }}
        >
          Copy the full receipt
        </Text>
      </Pressable>
    </>
  );
}
