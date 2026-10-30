/**
 * CampaignTranslationDictionarySection — the terminology dictionary inside
 * the translation-settings sheet.
 *
 * The list read is viewer (everyone sees which terms are locked); add and
 * delete are ADMIN routes and their affordances are omitted — never
 * disabled — below that floor. Deleting an entry loses its hand-typed
 * per-locale translations, so it runs through ConfirmSheet as destructive;
 * no typed phrase: the row is one visible line and re-adding it is cheap
 * next to, say, deleting a locale variant's translated body.
 *
 * The add form renders one input per SUPPORTED locale (a bounded, short
 * list); blank inputs are simply omitted from the map. CSV import/export
 * stays on the web.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import {
  ActionButton,
} from "@/components/campaigns/CampaignDetailControls";
import { CampaignFieldInput } from "@/components/campaigns/CampaignFieldInput";
import {
  useTranslationDictionaryDelete,
  useTranslationDictionaryUpsert,
} from "@/hooks/useCampaignTranslationSettings";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  dictionaryEntrySummary,
  termProblem,
  type TranslationDictionaryEntry,
} from "@/lib/campaignTranslationSettings";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignTranslationDictionarySection({
  entries,
  supportedLocales,
  canAdmin,
}: {
  entries: TranslationDictionaryEntry[];
  supportedLocales: string[];
  canAdmin: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const upsert = useTranslationDictionaryUpsert();
  const remove = useTranslationDictionaryDelete();
  const [adding, setAdding] = useState(false);
  const [term, setTerm] = useState("");
  const [byLocale, setByLocale] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);

  const busy = upsert.isPending || remove.isPending;
  const problem = termProblem(term);

  const onAdd = () => {
    if (busy) return;
    if (problem) {
      setShowErrors(true);
      return;
    }
    const translations: Record<string, string> = {};
    for (const [locale, text] of Object.entries(byLocale)) {
      if (text.trim() !== "") translations[locale] = text.trim();
    }
    haptics.tap();
    upsert.mutate(
      { term: term.trim(), translations, case_sensitive: false, notes: "" },
      {
        onSuccess: () => {
          setTerm("");
          setByLocale({});
          setShowErrors(false);
          setAdding(false);
          toast({ kind: "success", message: "Term locked in the dictionary." });
        },
        onError: (err: unknown) =>
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't save the term."),
          }),
      },
    );
  };

  const onDelete = (entry: TranslationDictionaryEntry) => {
    if (busy) return;
    void (async () => {
      const ok = await confirm({
        title: `Remove “${entry.term}”?`,
        message: "The translator stops enforcing this term.",
        confirmLabel: "Remove term",
        destructive: true,
        consequence:
          "Its locked per-locale translations are permanently removed.",
      });
      if (!ok) return;
      haptics.impact();
      remove.mutate(entry.id, {
        onSuccess: () =>
          toast({ kind: "success", message: `“${entry.term}” removed.` }),
        onError: (err: unknown) =>
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't remove the term."),
          }),
      });
    })();
  };

  return (
    <View style={{ marginTop: 16 }}>
      <Text
        {...typeCap("callout")}
        accessibilityRole="header"
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
        }}
      >
        Terminology dictionary
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
      >
        Terms the translator must render exactly as written — brand names,
        product tiers. CSV import and export stay on the web.
      </Text>

      {entries.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            marginTop: 8,
          }}
        >
          No terms locked yet.
        </Text>
      ) : (
        <View style={{ marginTop: 8, gap: 8 }}>
          {entries.map((entry) => (
            <View
              key={entry.id}
              accessible
              accessibilityLabel={dictionaryEntrySummary(entry)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.medium,
                  }}
                >
                  {dictionaryEntrySummary(entry)}
                </Text>
                {entry.notes ? (
                  <Text
                    {...typeCap("caption")}
                    style={{
                      color: t.fgSubtle,
                      ...typeStyle("caption"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {entry.notes}
                  </Text>
                ) : null}
              </View>
              {canAdmin ? (
                <ActionButton
                  label="Remove"
                  danger
                  onPress={() => onDelete(entry)}
                  disabled={busy}
                />
              ) : null}
            </View>
          ))}
        </View>
      )}

      {canAdmin ? (
        adding ? (
          <View style={{ marginTop: 10 }}>
            <CampaignFieldInput
              label="Term"
              value={term}
              onChangeText={setTerm}
              placeholder="Moosewave Pro"
              {...(showErrors && problem ? { error: problem } : {})}
            />
            {supportedLocales.map((locale) => (
              <CampaignFieldInput
                key={locale}
                label={`In ${locale}`}
                value={byLocale[locale] ?? ""}
                onChangeText={(next) =>
                  setByLocale((prev) => ({ ...prev, [locale]: next }))
                }
                placeholder="Leave blank to keep the term untranslated"
              />
            ))}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <ActionButton
                label="Cancel"
                onPress={() => setAdding(false)}
                disabled={busy}
              />
              <ActionButton
                label={upsert.isPending ? "Saving…" : "Save term"}
                primary
                onPress={onAdd}
                disabled={busy}
              />
            </View>
          </View>
        ) : (
          <View style={{ flexDirection: "row", marginTop: 10 }}>
            <ActionButton label="Add term" onPress={() => setAdding(true)} />
          </View>
        )
      ) : null}
    </View>
  );
}
