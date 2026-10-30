/**
 * PreferenceCenterThemeSection — theme the hosted preference centre from a phone.
 *
 * THE GAP. Desktop has had this editor since PrivacyPortal.tsx:118
 * (PreferenceCenterCustomization); mobile had no caller for
 * /api/v1/privacy/portal/preference-center at all, so the chrome of the page
 * SUBSCRIBERS land on from an unsubscribe link — logo, button colour, footer
 * sentence, Moosewave badge — could only be corrected from a desk.
 *
 * WHOSE RULES. Every refusal shown here is the server's own sentence,
 * transcribed in lib/preferenceCenterTheme from the Go validator, and the card
 * says so under the field. The white-on-primary contrast floor is OURS, so it
 * appears as a non-blocking WARNING that names who would refuse it — desktop
 * blocks a save on it, but the API's own default colour (#5B6CFF) measures
 * 4.17:1, so blocking here would freeze the card for every tenant that has
 * never edited their theme.
 *
 * FULL REPLACE. PATCH here is a full replace by the handler's own comment, so
 * the Save button always sends all four fields. That also means this is an
 * online-only write — see api/preferenceCenterTheme.
 *
 * ROLE. Both verbs are admin in the routeauth manifest, so the section renders
 * nothing below admin: the screen's "administrative controls are hidden" notice
 * already explains the omission.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  getPreferenceCenterTheme,
  savePreferenceCenterTheme,
} from "@/api/preferenceCenterTheme";
import { QueryStates } from "@/components/QueryStates";
import { SettingsSwitchRow, SettingsTextInput } from "@/components/settings/FormControls";
import { PreferenceCenterThemePreview } from "@/components/settings/PreferenceCenterThemePreview";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useDirtyGuard } from "@/hooks/useDirtyGuard";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  PREFERENCE_THEME_DEFAULTS,
  PREFERENCE_THEME_LIMITS,
  preferenceFooterBytes,
  preferenceThemeContrastAdvisory,
  preferenceThemeDirty,
  preferenceThemeIssue,
  preferenceThemeSaveError,
  type PreferenceCenterTheme,
  type PreferenceThemeIssue,
} from "@/lib/preferenceCenterTheme";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Said under every refusal, so nobody mistakes our wording for the API's. */
const REFUSAL_PROVENANCE =
  "The API's own sentence: it refuses this value with these exact words.";

export function PreferenceCenterThemeSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const canAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const qc = useQueryClient();
  const { toast } = useToast();
  const queryKey = ["settings-preference-center-theme", gate.tenantId];

  const [baseline, setBaseline] = useState<PreferenceCenterTheme | null>(null);
  const [draft, setDraft] = useState<PreferenceCenterTheme>(
    PREFERENCE_THEME_DEFAULTS,
  );
  const [saving, setSaving] = useState(false);

  const theme = useQuery({
    queryKey,
    enabled: canAdmin && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<PreferenceCenterTheme> => {
      const res = await getPreferenceCenterTheme();
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return res.data;
    },
  });

  const dirty = baseline !== null && preferenceThemeDirty(baseline, draft);
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Adopt the server's answer on arrival — but never over an edit in progress:
  // a background refetch that replaced what someone was typing would be a
  // silent data loss on a subscriber-facing setting.
  const served = theme.data;
  useEffect(() => {
    if (!served || dirtyRef.current) return;
    setBaseline((current) => {
      if (current && !preferenceThemeDirty(current, served)) return current;
      return served;
    });
    setDraft((current) =>
      preferenceThemeDirty(current, served) ? served : current,
    );
  }, [served]);

  useDirtyGuard("preference-center-theme", "Preference-centre theme", dirty);

  if (!canAdmin) return null;

  const issue = preferenceThemeIssue(draft);
  const advisory = preferenceThemeContrastAdvisory(draft);
  const footerBytes = preferenceFooterBytes(draft.footerText);
  const canSave = dirty && !saving && !issue && gate.enabled;

  async function onSave() {
    if (saving || !dirty) return;
    const blocking = preferenceThemeIssue(draft);
    if (blocking) {
      haptics.error();
      toast({ kind: "error", message: blocking.message });
      return;
    }
    setSaving(true);
    const res = await savePreferenceCenterTheme(draft);
    setSaving(false);
    if (res.error) {
      haptics.error();
      toast({ kind: "error", message: preferenceThemeSaveError(res.error) });
      return;
    }
    // The PATCH answers the row it stored, normalisation included — it IS the
    // fresh read, so it becomes both the baseline and what the fields show.
    qc.setQueryData(queryKey, res.data);
    setBaseline(res.data);
    setDraft(res.data);
    haptics.success();
    toast({
      kind: "success",
      message: "Saved. The hosted preference centre uses this theme now.",
    });
  }

  return (
    <>
      <SectionHeader
        title="Preference centre theme"
        subtitle="The logo, button colour, footer and badge on the hosted subscribe / unsubscribe page. Saving replaces all four at once."
      />
      <Card>
        <QueryStates
          query={theme}
          isEmpty={baseline === null}
          gate={gate}
          offlineMessage="Reconnect to load the preference-centre theme. Theming is an online-only write."
          skeleton={
            <SkeletonList rows={3} lines={1} label="Loading the preference-centre theme" />
          }
        >
          <View style={{ gap: 12 }}>
            <SettingsTextInput
              label="Logo URL"
              hint={`Public https URL, no embedded credentials, up to ${PREFERENCE_THEME_LIMITS.logoUrlMaxBytes} bytes. Leave empty for no logo.`}
              value={draft.logoUrl}
              onChangeText={(value) =>
                setDraft((current) => ({ ...current, logoUrl: value }))
              }
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!saving}
            />
            <FieldIssue issue={issue} field="logoUrl" />

            <SettingsTextInput
              label="Primary colour"
              hint="Six-digit hex, e.g. #2563EB. Empty saves the Moosewave default."
              value={draft.primaryColor}
              onChangeText={(value) =>
                setDraft((current) => ({ ...current, primaryColor: value }))
              }
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={7}
              editable={!saving}
            />
            <FieldIssue issue={issue} field="primaryColor" />
            {issue?.field === "primaryColor" || !advisory ? null : (
              <View style={{ marginTop: -6 }}>
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.warning,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {advisory.message}
                </Text>
              </View>
            )}

            <SettingsTextInput
              label="Footer text"
              hint={`${num(footerBytes)} of ${num(
                PREFERENCE_THEME_LIMITS.footerMaxBytes,
              )} bytes used.`}
              value={draft.footerText}
              onChangeText={(value) =>
                setDraft((current) => ({ ...current, footerText: value }))
              }
              multiline
              editable={!saving}
              style={{ minHeight: 88 }}
            />
            <FieldIssue issue={issue} field="footerText" />

            <SettingsSwitchRow
              label="Show the “Powered by Moosewave” badge"
              value={draft.showPostwaveBadge}
              disabled={saving}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, showPostwaveBadge: value }))
              }
            />

            <PreferenceCenterThemePreview
              theme={draft}
              verified={baseline !== null}
            />

            <Pressable
              onPress={() => void onSave()}
              disabled={!canSave}
              accessibilityRole="button"
              accessibilityLabel="Save preference centre theme"
              accessibilityState={{ disabled: !canSave, busy: saving }}
              style={{
                paddingVertical: 12,
                borderRadius: 10,
                backgroundColor: t.accent,
                alignItems: "center",
                justifyContent: "center",
                minHeight: 44,
                opacity: canSave ? 1 : 0.5,
              }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.accentFg,
                  ...typeStyle("body"),
                  fontWeight: "700",
                  fontFamily: FONT.bold,
                }}
              >
                {saving ? "Saving…" : "Save theme"}
              </Text>
            </Pressable>

            <View style={{ flexDirection: "row", gap: 8 }}>
              <SecondaryAction
                label="Use defaults"
                disabled={saving}
                onPress={() => setDraft(PREFERENCE_THEME_DEFAULTS)}
              />
              <SecondaryAction
                label="Discard changes"
                disabled={saving || !dirty}
                onPress={() => {
                  if (baseline) setDraft(baseline);
                }}
              />
            </View>

            {gate.enabled ? null : (
              <Caption text="You're offline. Theming is an online-only write — nothing is queued." />
            )}
          </View>
        </QueryStates>
      </Card>
    </>
  );
}

/** The refusal for one field, with a line naming whose rule it is. */
function FieldIssue({
  issue,
  field,
}: {
  issue: PreferenceThemeIssue | null;
  field: PreferenceThemeIssue["field"];
}) {
  const { t } = useTheme();
  if (!issue || issue.field !== field) return null;
  return (
    <View style={{ gap: 2, marginTop: -6 }}>
      <Text
        {...typeCap("caption")}
        accessibilityRole="alert"
        style={{
          color: t.danger,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {issue.message}
      </Text>
      <Caption text={REFUSAL_PROVENANCE} />
    </View>
  );
}

function SecondaryAction({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        flex: 1,
        paddingVertical: 10,
        borderRadius: 10,
        borderColor: t.border,
        borderWidth: 1,
        alignItems: "center",
        justifyContent: "center",
        minHeight: 44,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Caption({ text }: { text: string }) {
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
      {text}
    </Text>
  );
}
