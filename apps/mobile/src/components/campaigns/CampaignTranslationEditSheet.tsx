/**
 * CampaignTranslationEditSheet — fix a locale's subject, or remove a bad
 * variant, from the phone.
 *
 * The card below it stayed read-only for a long time on the theory that
 * authoring translations is not phone work — which is true of BODIES and
 * false of the two review verbs a phone actually needs: correcting a
 * locale's SUBJECT (typing one line) and deleting a variant that should not
 * ship. Desktop's CampaignTranslationsPanel has both; body editing stays on
 * the web.
 *
 * THE PUT IS A FULL-ROW REPLACE server-side, so the subject save goes
 * through lib/campaignTranslations.translationUpsertBody, which carries the
 * existing translated bodies forward — a subject edit must never erase them.
 *
 * DELETE is destructive AND irreversible (the translated content is gone),
 * so it runs through ConfirmSheet with a typed phrase — the locale code.
 *
 * Both verbs are editor (routeauth) and ONLINE-ONLY: the replace body is
 * built from the freshest row the client holds (hooks/
 * useCampaignTranslationsEdit says why replaying a stale copy is data loss).
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { CampaignFieldInput } from "@/components/campaigns/CampaignFieldInput";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import {
  useCampaignTranslationDelete,
  useCampaignTranslationUpsert,
} from "@/hooks/useCampaignTranslationsEdit";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  translationUpsertBody,
  type TranslationEditRow,
} from "@/lib/campaignTranslations";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignTranslationEditSheet({
  campaignId,
  row,
  onClose,
  returnFocusRef,
}: {
  campaignId: string;
  /** Null closes the sheet. */
  row: TranslationEditRow | null;
  onClose: () => void;
  returnFocusRef?: ReturnFocusRef | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const upsert = useCampaignTranslationUpsert(campaignId);
  const remove = useCampaignTranslationDelete(campaignId);
  const [subject, setSubject] = useState(row?.subject ?? "");
  const locale = row?.locale ?? "";

  useEffect(() => {
    setSubject(row?.subject ?? "");
  }, [row]);

  const busy = upsert.isPending || remove.isPending;
  const dirty = row !== null && subject.trim() !== row.subject.trim();

  const onSave = () => {
    if (!row || busy || !dirty) return;
    haptics.tap();
    upsert.mutate(
      { locale: row.locale, body: translationUpsertBody(row, subject) },
      {
        onSuccess: () => {
          onClose();
          toast({
            kind: "success",
            message: `Subject for ${row.locale} updated.`,
          });
        },
        onError: (err: unknown) =>
          toast({
            kind: "error",
            message: campaignErrorMessage(
              err,
              "Couldn't save the translated subject.",
            ),
          }),
      },
    );
  };

  const onDelete = () => {
    if (!row || busy) return;
    void (async () => {
      const ok = await confirm({
        title: `Delete the ${row.locale} variant?`,
        message:
          "Recipients in this locale will get the campaign's default language instead.",
        confirmLabel: "Delete variant",
        destructive: true,
        consequence:
          "The translated subject and body for this locale are permanently removed.",
        confirmPhrase: row.locale,
      });
      if (!ok) return;
      haptics.impact();
      remove.mutate(row.locale, {
        onSuccess: () => {
          onClose();
          toast({
            kind: "success",
            message: `The ${row.locale} variant was deleted.`,
          });
        },
        onError: (err: unknown) =>
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't delete the variant."),
          }),
      });
    })();
  };

  return (
    <KeyboardFormSheet
      visible={row !== null}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      accessibilityLabel={`Edit the ${locale} translation`}
    >
      <ModalHeader title={`Locale ${locale}`} onClose={onClose} />
      <CampaignFieldInput
        label="Translated subject"
        value={subject}
        onChangeText={setSubject}
        placeholder="Leave blank to fall back to the default subject"
        multiline
        hint="Blank means recipients in this locale get the campaign's DEFAULT subject over the translated body."
      />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 4,
        }}
      >
        The translated body is preserved as-is — body editing stays on the web.
      </Text>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginTop: 20,
          gap: 8,
        }}
      >
        <ActionButton
          label={remove.isPending ? "Deleting…" : "Delete variant"}
          danger
          onPress={onDelete}
          disabled={busy}
        />
        <ActionButton
          label={upsert.isPending ? "Saving…" : "Save subject"}
          primary
          onPress={onSave}
          disabled={busy || !dirty}
        />
      </View>
    </KeyboardFormSheet>
  );
}
