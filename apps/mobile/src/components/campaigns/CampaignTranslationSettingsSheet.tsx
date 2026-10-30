/**
 * CampaignTranslationSettingsSheet — turn translations on, choose the
 * locales, fix a brand term. Desktop's TranslationsPanel, phone-shaped.
 *
 * Reached from CampaignTranslationsCard because that is where the absence
 * bites: the reviewer looking at locale variants is the person who needs the
 * machinery configured. Reads are viewer (settings + dictionary); every
 * write and the LLM preview are ADMIN in the routeauth manifest, so below
 * admin the sheet is a read surface with ONE caption naming the rule.
 *
 * The settings PUT is PARTIAL — only fields the admin actually changed are
 * sent, so two admins editing different knobs cannot clobber each other's
 * halves. Writes are online-only (api/campaignTranslationSettingsApi).
 */
import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";

import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import { CampaignFieldInput } from "@/components/campaigns/CampaignFieldInput";
import { CampaignTranslationDictionarySection } from "@/components/campaigns/CampaignTranslationDictionarySection";
import {
  useTranslationDictionary,
  useTranslationPreview,
  useTranslationSettings,
  useTranslationSettingsWrite,
} from "@/hooks/useCampaignTranslationSettings";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  localeProblem,
  parseLocalesList,
  translationPreviewNote,
  translationSettingsSentence,
  type TranslationFallbackStrategy,
  type TranslationSettingsReading,
} from "@/lib/campaignTranslationSettings";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** The partial PUT body — only what actually changed. */
export function settingsPutBody(
  saved: TranslationSettingsReading,
  draft: {
    enabled: boolean;
    defaultLocale: string;
    localesText: string;
    fallback: TranslationFallbackStrategy;
  },
): {
  enabled?: boolean;
  default_locale?: string;
  supported_locales?: string[];
  fallback_strategy?: string;
} {
  const body: {
    enabled?: boolean;
    default_locale?: string;
    supported_locales?: string[];
    fallback_strategy?: string;
  } = {};
  if (draft.enabled !== saved.enabled) body.enabled = draft.enabled;
  const nextDefault = draft.defaultLocale.trim();
  if (nextDefault !== saved.defaultLocale) body.default_locale = nextDefault;
  const nextLocales = parseLocalesList(draft.localesText);
  if (nextLocales.join(",") !== saved.supportedLocales.join(",")) {
    body.supported_locales = nextLocales;
  }
  if (draft.fallback !== saved.fallbackStrategy) {
    body.fallback_strategy = draft.fallback;
  }
  return body;
}

export function CampaignTranslationSettingsSheet({
  visible,
  onClose,
  canAdmin,
  returnFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  canAdmin: boolean;
  returnFocusRef?: ReturnFocusRef | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const settings = useTranslationSettings({ enabled: visible });
  const dictionary = useTranslationDictionary({ enabled: visible });
  const write = useTranslationSettingsWrite();
  const preview = useTranslationPreview();

  const saved = settings.data ?? null;
  const [enabled, setEnabled] = useState(false);
  const [defaultLocale, setDefaultLocale] = useState("");
  const [localesText, setLocalesText] = useState("");
  const [fallback, setFallback] =
    useState<TranslationFallbackStrategy>("subscriber_locale");
  const [previewBody, setPreviewBody] = useState("");
  const [previewLocale, setPreviewLocale] = useState("");

  // Re-seed the draft whenever the saved settings (re)arrive.
  useEffect(() => {
    if (!saved) return;
    setEnabled(saved.enabled);
    setDefaultLocale(saved.defaultLocale);
    setLocalesText(saved.supportedLocales.join(", "));
    setFallback(saved.fallbackStrategy);
    setPreviewLocale((prev) =>
      prev !== ""
        ? prev
        : saved.supportedLocales.find((l) => l !== saved.defaultLocale) ?? "",
    );
  }, [saved]);

  const body = saved
    ? settingsPutBody(saved, { enabled, defaultLocale, localesText, fallback })
    : {};
  const dirty = Object.keys(body).length > 0;
  const defaultProblem =
    defaultLocale.trim() === "" ? null : localeProblem(defaultLocale);
  const localesProblem =
    parseLocalesList(localesText).map(localeProblem).find(Boolean) ?? null;
  const previewLocaleProblem =
    previewLocale.trim() === "" ? "Name the locale to render." : localeProblem(previewLocale);
  const busy = write.isPending;

  const onSave = () => {
    if (!saved || busy || !dirty || defaultProblem || localesProblem) return;
    haptics.tap();
    write.mutate(body, {
      onSuccess: () =>
        toast({ kind: "success", message: "Translation settings saved." }),
      onError: (err: unknown) =>
        toast({
          kind: "error",
          message: campaignErrorMessage(err, "Couldn't save the settings."),
        }),
    });
  };

  const onPreview = () => {
    if (preview.isPending || previewBody.trim() === "" || previewLocaleProblem)
      return;
    haptics.tap();
    preview.mutate(
      { body: previewBody, locale: previewLocale.trim() },
      {
        onError: (err: unknown) =>
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't render the preview."),
          }),
      },
    );
  };

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      accessibilityLabel="Translation settings"
    >
      <ModalHeader title="Translation settings" onClose={onClose} />

      {settings.isPending ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Checking the workspace settings…
        </Text>
      ) : saved ? (
        <>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {translationSettingsSentence(saved)}
          </Text>

          {canAdmin ? (
            <>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: 12,
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
                  Translate campaigns automatically
                </Text>
                <Switch
                  value={enabled}
                  onValueChange={(next) => {
                    haptics.tap();
                    setEnabled(next);
                  }}
                  disabled={busy}
                  accessibilityLabel="Translate campaigns automatically"
                />
              </View>

              <CampaignFieldInput
                label="Default locale"
                value={defaultLocale}
                onChangeText={setDefaultLocale}
                placeholder="en"
                autoCapitalize="none"
                autoCorrect={false}
                {...(defaultProblem ? { error: defaultProblem } : {})}
              />
              <CampaignFieldInput
                label="Supported locales"
                value={localesText}
                onChangeText={setLocalesText}
                placeholder="en, es, pt-BR"
                autoCapitalize="none"
                autoCorrect={false}
                {...(localesProblem
                  ? { error: localesProblem }
                  : { hint: "Comma-separated. Recipients outside this list fall back." })}
              />
              <View style={{ marginTop: 10, gap: 6 }}>
                <SegmentedControl<TranslationFallbackStrategy>
                  options={[
                    { value: "subscriber_locale", label: "Match subscriber" },
                    { value: "default_only", label: "Default only" },
                  ]}
                  value={fallback}
                  onChange={setFallback}
                  accessibilityLabel="Fallback strategy"
                />
              </View>
              <View style={{ flexDirection: "row", marginTop: 12 }}>
                <ActionButton
                  label={busy ? "Saving…" : "Save settings"}
                  primary
                  onPress={onSave}
                  disabled={busy || !dirty}
                />
              </View>
            </>
          ) : (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
            >
              Changing translation settings, the dictionary or the preview
              needs the admin role.
            </Text>
          )}

          <CampaignTranslationDictionarySection
            entries={Array.isArray(dictionary.data) ? dictionary.data : []}
            supportedLocales={saved.supportedLocales}
            canAdmin={canAdmin}
          />

          {canAdmin ? (
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
                Try the translator
              </Text>
              <CampaignFieldInput
                label="Text to translate"
                value={previewBody}
                onChangeText={setPreviewBody}
                placeholder="A sentence, with your brand terms in it"
                multiline
              />
              <CampaignFieldInput
                label="Into locale"
                value={previewLocale}
                onChangeText={setPreviewLocale}
                placeholder="es"
                autoCapitalize="none"
                autoCorrect={false}
                {...(previewLocale.trim() !== "" && previewLocaleProblem
                  ? { error: previewLocaleProblem }
                  : {})}
              />
              <View style={{ flexDirection: "row", marginTop: 8 }}>
                <ActionButton
                  label={preview.isPending ? "Translating…" : "Preview translation"}
                  onPress={onPreview}
                  disabled={
                    preview.isPending ||
                    previewBody.trim() === "" ||
                    previewLocaleProblem !== null
                  }
                />
              </View>
              {preview.data ? (
                <View style={{ marginTop: 8, gap: 4 }}>
                  <Text
                    {...typeCap("bodySmall")}
                    style={{
                      color: t.fg,
                      ...typeStyle("bodySmall"),
                      fontFamily: FONT.regular,
                      writingDirection: "auto",
                    }}
                  >
                    {preview.data.body}
                  </Text>
                  <Text
                    {...typeCap("caption")}
                    style={{
                      color: t.fgSubtle,
                      ...typeStyle("caption"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {translationPreviewNote(preview.data)}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      ) : (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {settings.error
            ? campaignErrorMessage(
                settings.error,
                "Couldn't load the translation settings.",
              )
            : "Couldn't load the translation settings."}
        </Text>
      )}
    </KeyboardFormSheet>
  );
}
