/**
 * FrameworkDetailCard — what the record actually says about one framework.
 *
 * THIS CARD IS THE EVIDENCE, NOT THE CLAIM. A status of "attested" is a claim;
 * the signer, the countersigner, the document path and the SHA-256 of the
 * signed document are what makes it auditable. The upsert preserves a prior
 * hash across a renewal that omits one (compliance.go:250-251), so a hash that
 * is STILL empty means no document hash has ever been recorded for this
 * framework — an attestation with nothing attached. That is stated outright,
 * because it is precisely the thing an auditor asks about and precisely the
 * thing a green "Attested" pill hides.
 *
 * EVERY ABSENT STAMP IS AN EM-DASH, NEVER A DATE. `attestedAt`, `renewalAt`
 * and `updatedAt` are `*time.Time` with `omitempty` (compliance.go:80-82), so
 * an absent one has no key at all and normalizes to "". Rendering an epoch
 * there would put "Jan 1, 1970" under the word "Attested".
 *
 * THE HASH IS COPYABLE AND THE PATH IS NOT TAPPABLE. Copying the digest is the
 * one genuinely useful phone action here — it is what you paste next to the
 * file you are checking. `documentPath` is an internal URI (`s3://…`,
 * migration 0193 line 18) that no phone can open, so it is shown as text.
 */
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { postureStateExplanation } from "@/lib/complianceLabels";
import type { ProgramPosture } from "@/lib/compliancePosture";
import { copyToClipboard } from "@/lib/clipboard";
import { EMDASH, dateTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function Fact({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={
        value === EMDASH ? `${label}: not recorded` : `${label}: ${value}`
      }
      style={{ flexDirection: "row", gap: 10, minHeight: 24 }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          width: 110,
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: value === EMDASH ? t.fgMuted : t.fg,
          ...typeStyle("bodySmall"),
          flex: 1,
          fontFamily: FONT.regular,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export function FrameworkDetailCard({ row }: { row: ProgramPosture }) {
  const { t } = useTheme();
  const { toast } = useToast();
  const program = row.program;
  const hash = program.documentSha256;

  const onCopyHash = useCallback(() => {
    if (!hash) return;
    haptics.tap();
    void copyToClipboard(hash).then((ok) =>
      toast(
        ok
          ? { kind: "success", message: "Document hash copied." }
          : { kind: "error", message: "Couldn't reach the clipboard." },
      ),
    );
  }, [hash, toast]);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 12,
      }}
    >
      <View>
        <Text
          accessibilityRole="header"
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {row.meta.full}
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {postureStateExplanation(row)}
        </Text>
      </View>

      {row.state === "unsupported" ? null : (
        <View style={{ gap: 6 }}>
          <Fact label="Signed by" value={program.signedByEmail || EMDASH} />
          <Fact label="Countersigner" value={program.signerName || EMDASH} />
          <Fact label="Attested" value={dateTime(program.attestedAt, EMDASH)} />
          <Fact label="Renews" value={dateTime(program.renewalAt, EMDASH)} />
          <Fact
            label="Last changed"
            value={dateTime(program.updatedAt, EMDASH)}
          />
          <Fact label="Document" value={program.documentPath || EMDASH} />
        </View>
      )}

      {row.state === "unsupported" ? null : hash ? (
        <Pressable
          onPress={onCopyHash}
          accessibilityRole="button"
          accessibilityLabel={`Copy the document SHA-256, ${hash}`}
          accessibilityHint="Copies the signed document's hash to the clipboard"
          style={{
            backgroundColor: t.surfaceElevated,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            minHeight: 44,
            justifyContent: "center",
            gap: 2,
          }}
        >
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Document SHA-256 · tap to copy
          </Text>
          <Text
            {...typeCap("mono")}
            style={{
              color: t.fg,
              ...typeStyle("mono"),
              fontFamily: FONT.regular,
            }}
          >
            {hash}
          </Text>
        </Pressable>
      ) : row.attested ? (
        <View
          accessible
          accessibilityLabel="No document hash has ever been recorded for this attestation. The record names a signer but nothing pins the document they signed."
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <Pill label="No document hash" tone="warning" />
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              flex: 1,
              fontFamily: FONT.regular,
            }}
          >
            Nothing pins the document that was signed.
          </Text>
        </View>
      ) : null}

      {program.notes && row.state !== "unsupported" ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {program.notes}
        </Text>
      ) : null}
    </View>
  );
}
