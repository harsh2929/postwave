/**
 * CampaignTranslationsCard — "this campaign is not only in English".
 *
 * Sits directly above the Preview block, because that is the block it
 * qualifies: the preview shows ONE language, and until now nothing on this
 * screen said so. A phone reviewer approving a five-locale send reviewed one
 * fifth of it and had no way to know.
 *
 * SELF-EFFACING. It renders nothing for a single-language campaign — which is
 * almost all of them — so the 95% case pays no attention tax for the 5%.
 *
 * THE FALLBACKS ARE THE POINT. A locale row whose subject is blank does not
 * mean "no subject": the gateway substitutes the campaign default, so those
 * recipients read an English subject over a Spanish body. Each incomplete
 * locale therefore says, in words, what its recipients will actually receive —
 * see `translationFallbackNote`.
 *
 * READ-ONLY. Authoring a translation is not phone work, and PUT/DELETE are
 * write-scope; this surfaces what exists so the review can be honest.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { CampaignTranslationEditSheet } from "@/components/campaigns/CampaignTranslationEditSheet";
import { CampaignTranslationSettingsSheet } from "@/components/campaigns/CampaignTranslationSettingsSheet";
import type {
  TranslationEditRow,
  TranslationsListWire,
  TranslationsReading,
} from "@/lib/campaignTranslations";
import {
  translationEditRows,
  translationFallbackNote,
} from "@/lib/campaignTranslations";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignTranslationsCard({
  reading,
  campaignId,
  canMutate = false,
  canAdmin = false,
  wire = null,
}: {
  reading: TranslationsReading;
  /** Needed for the edit/delete verbs; without it the card stays read-only. */
  campaignId?: string | undefined;
  /** Editor floor (PUT/DELETE …/translations/{locale} are write-scope). A
      viewer sees the list and no verbs — omitted, not disabled. */
  canMutate?: boolean | undefined;
  /** Admin floor for the TENANT half (settings PUT, dictionary writes, LLM
      preview). Gates the settings sheet's write affordances, and is what
      keeps the card visible (as one row) on a single-language campaign — an
      admin must be able to reach "turn translations ON" from here. */
  canAdmin?: boolean | undefined;
  /** The raw list response, so a subject edit can PRESERVE the bodies the
      full-row-replace PUT would otherwise erase. */
  wire?: TranslationsListWire | null | undefined;
}) {
  const { t } = useTheme();
  const [editing, setEditing] = useState<TranslationEditRow | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const editRows = useMemo(() => translationEditRows(wire), [wire]);
  if (reading.empty) {
    // Self-effacing for everyone EXCEPT the admin, who needs an entry point
    // to enable translations before any variant can exist.
    if (!canAdmin) return null;
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 16,
          gap: 12,
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            flex: 1,
          }}
        >
          One language only. Automatic translation is configured in settings.
        </Text>
        <ActionButton
          label="Translation settings"
          onPress={() => setSettingsOpen(true)}
        />
        <CampaignTranslationSettingsSheet
          visible={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          canAdmin={canAdmin}
        />
      </View>
    );
  }
  const canEdit = Boolean(canMutate && campaignId);

  const n = reading.rows.length;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: reading.partialCount > 0 ? t.warning : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginTop: 16,
        gap: 10,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("callout")}
          accessibilityRole="header"
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          Sends in {n} other language{n === 1 ? "" : "s"}
        </Text>
        {/* Settings reads are viewer, so the sheet is offered to every role;
            its write affordances gate on canAdmin inside. */}
        <ActionButton label="Settings" onPress={() => setSettingsOpen(true)} />
      </View>

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        The preview below is the DEFAULT language only. Recipients whose locale
        matches one of these get the version listed here instead.
      </Text>

      <View style={{ gap: 10 }}>
        {reading.rows.map((row) => {
          const note = translationFallbackNote(row);
          return (
            <View
              key={row.locale}
              accessible
              accessibilityLabel={[
                `Locale ${row.locale}`,
                row.subject ? `Subject: ${row.subject}` : null,
                note,
              ]
                .filter(Boolean)
                .join(". ")}
              style={{ gap: 4 }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                {/* The locale code is an identifier the operator may need to
                    match against their own list, so it reads as `mono`. */}
                <Pill label={row.locale} />
                {note ? (
                  // Not colour-alone: the pill says "Partial" in words and the
                  // sentence under it says which half is missing.
                  <Pill label="Partial" tone="warning" />
                ) : null}
                {(() => {
                  // Edit is offered ONLY when the raw row (with its bodies)
                  // is in hand: the PUT is a full-row replace, and editing
                  // from a reading that lacks the bodies would erase them.
                  const editRow = canEdit
                    ? editRows.find((r) => r.locale === row.locale)
                    : undefined;
                  return editRow ? (
                    <ActionButton
                      label="Edit"
                      onPress={() => setEditing(editRow)}
                    />
                  ) : null;
                })()}
              </View>

              {row.subject ? (
                <Text
                  {...typeCap("bodySmall")}
                  numberOfLines={2}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                    // Translated subjects are the exact case for `auto`: an
                    // Arabic or Hebrew subject must lay out right-to-left.
                    writingDirection: "auto",
                  }}
                >
                  {row.subject}
                </Text>
              ) : null}

              {note ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.warning,
                    ...typeStyle("caption"),
                    fontFamily: FONT.medium,
                  }}
                >
                  {note}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
      {canEdit && campaignId ? (
        <CampaignTranslationEditSheet
          campaignId={campaignId}
          row={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <CampaignTranslationSettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        canAdmin={canAdmin}
      />
    </View>
  );
}
