/**
 * WorkspaceSettingsSection — mobile parity for the desktop's workspace
 * settings panel. Surfaces the same fields the gateway accepts on
 * PATCH /api/v1/settings/workspace:
 *
 *   - display_name
 *   - default_reply_to
 *   - timezone
 *   - brand_color
 *   - logo_url
 *
 * The form is "dirty-aware": Save is enabled only when at least one
 * field has changed. We never PATCH the unchanged ones — backend
 * accepts a partial body so a per-field PATCH is the simplest path.
 *
 * Honest fallback: 404 from the gateway renders the muted "feature
 * unavailable" message (same shape as the other settings sections).
 *
 * Outcomes are toasts, not Alerts: this renders inline on the Settings
 * screen, whose contract is a toast after an action (Toast.tsx), and a modal
 * "Saved" cost a tap on every save.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import {
  getWorkspaceSettings,
  patchWorkspaceSettings,
  type WorkspaceSettings,
} from "@/api/settings";
import { Chip } from "@/components/Chip";
import { useToast } from "@/components/Toast";
import {
  SettingsField,
  SettingsTextInput,
  settingsInputStyle,
} from "@/components/settings/FormControls";
import { useDirtyGuard } from "@/hooks/useDirtyGuard";
import { ProvenanceLine } from "@/components/settings/ProvenanceLine";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardDismiss } from "@/lib/keyboardChain";
import {
  WORKSPACE_DATE_FORMATS,
  workspaceDateFormatPatch,
  workspaceDateFormatSummary,
} from "@/lib/workspaceDateFormat";

interface Draft {
  display_name: string;
  default_reply_to: string;
  timezone: string;
  /** One of settings.allowedDateFormats; "" while the column is unset. */
  date_format: string;
  brand_color: string;
  logo_url: string;
}

function emptyDraft(): Draft {
  return {
    display_name: "",
    default_reply_to: "",
    timezone: "",
    date_format: "",
    brand_color: "",
    logo_url: "",
  };
}

function fromServer(s: WorkspaceSettings): Draft {
  return {
    display_name: s.display_name ?? "",
    default_reply_to: s.default_reply_to ?? "",
    timezone: s.timezone ?? "",
    date_format: s.date_format ?? "",
    brand_color: s.brand_color ?? "",
    logo_url: s.logo_url ?? "",
  };
}

/** The audit fields the payload has always carried and nothing ever rendered. */
interface Provenance {
  updated_at?: string | undefined;
  updated_by_user_id?: string | null | undefined;
}

export function WorkspaceSettingsSection() {
  const { t } = useTheme();
  const { toast } = useToast();
  const [meta, setMeta] = useState<Provenance>({});
  const [orig, setOrig] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getWorkspaceSettings();
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        if (res.error.status === 404 || res.error.status === 501) {
          setUnavailable(true);
        }
        return;
      }
      if (res.data) {
        const d = fromServer(res.data);
        setOrig(d);
        setDraft(d);
        setMeta({
          updated_at: res.data.updated_at,
          updated_by_user_id: res.data.updated_by_user_id,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty =
    orig !== null &&
    (Object.keys(draft) as (keyof Draft)[]).some(
      (k) => (draft[k] ?? "") !== (orig[k] ?? ""),
    );
  // Save was already dirty-aware; nothing stopped LEAVING mid-edit. Declared
  // before the early returns below so the flag is always cleared on unmount.
  useDirtyGuard("workspace-settings", "Workspace", dirty);

  const onSave = async () => {
    if (!orig) return;
    // date_format is the one field here with a CLOSED server-side vocabulary
    // (settings.allowedDateFormats), so it is decided by the shared policy
    // rather than the generic changed-field loop: an unrecognised value — one
    // this build does not know but the column holds — is refused here, in the
    // handler's own sentence, instead of spending a round trip to be told.
    const dateFormat = workspaceDateFormatPatch(orig.date_format, draft.date_format);
    if (!dateFormat.ok) {
      toast({ kind: "error", message: dateFormat.message });
      return;
    }
    setSaving(true);
    const patch: Parameters<typeof patchWorkspaceSettings>[0] = {};
    (Object.keys(draft) as (keyof Draft)[]).forEach((k) => {
      if (k === "date_format") return;
      const next = draft[k];
      if ((next ?? "") !== (orig[k] ?? "")) {
        patch[k] = next;
      }
    });
    if (dateFormat.value !== null) patch.date_format = dateFormat.value;
    const res = await patchWorkspaceSettings(patch);
    setSaving(false);
    if (res.error || !res.data) {
      const detail = res.error?.message ?? "";
      toast({
        kind: "error",
        message: `Couldn't save workspace settings. ${detail}`.trim(),
      });
      return;
    }
    const d = fromServer(res.data);
    setOrig(d);
    setDraft(d);
    setMeta({
      updated_at: res.data.updated_at,
      updated_by_user_id: res.data.updated_by_user_id,
    });
    toast({ kind: "success", message: "Workspace settings updated." });
  };

  if (unavailable) {
    return <Notice text="Workspace settings unavailable on this deployment." />;
  }
  if (loading) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        Loading workspace settings…
      </Text>
    );
  }
  if (!orig) {
    return <Notice text="Couldn't load workspace settings." />;
  }

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 16,
        padding: 14,
        gap: 10,
      }}
    >
      <SettingsTextInput
        label="Display name"
        value={draft.display_name}
        onChangeText={(v) => setDraft((d) => ({ ...d, display_name: v }))}
        placeholder="Acme, Inc."
        placeholderTextColor={t.fgSubtle}
      />
      <SettingsTextInput
        label="Default reply-to"
        value={draft.default_reply_to}
        onChangeText={(v) => setDraft((d) => ({ ...d, default_reply_to: v }))}
        placeholder="hello@acme.com"
        placeholderTextColor={t.fgSubtle}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <SettingsTextInput
        label="Timezone"
        value={draft.timezone}
        onChangeText={(v) => setDraft((d) => ({ ...d, timezone: v }))}
        placeholder="America/Los_Angeles"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {/* The fourth field desktop's WorkspaceProfileSection offers on this
          same endpoint, and the only one mobile omitted. Chips rather than a
          text input because the server's vocabulary is closed — four values,
          anything else is 400 bad_date_format. */}
      <SettingsField
        label="Date format"
        hint={workspaceDateFormatSummary(draft.date_format)}
      >
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Workspace date format"
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
        >
          {WORKSPACE_DATE_FORMATS.map((option) => (
            <Chip
              key={option.value}
              label={option.example}
              accessibilityLabel={option.label}
              active={draft.date_format.trim() === option.value}
              onPress={() =>
                setDraft((d) => ({ ...d, date_format: option.value }))
              }
            />
          ))}
        </View>
      </SettingsField>
      <SettingsField label="Brand color (hex)">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: /^#[0-9a-fA-F]{6}$/.test(draft.brand_color)
                ? draft.brand_color
                : t.bgSubtle,
            }}
          />
          <TextInput
            // Inputs scale with the OS text size but their height does not — cap it.
            {...typeCap("body")}
            value={draft.brand_color}
            onChangeText={(v) => setDraft((d) => ({ ...d, brand_color: v }))}
            placeholder="#C8102E"
            placeholderTextColor={t.fgSubtle}
            accessibilityLabel="Brand color (hex)"
            accessibilityHint="Enter a six-digit hex color starting with #."
            autoCapitalize="none"
            autoCorrect={false}
            {...keyboardDismiss()}
            style={[settingsInputStyle(t), { flex: 1 }]}
          />
        </View>
      </SettingsField>
      <SettingsTextInput
        label="Logo URL"
        value={draft.logo_url}
        onChangeText={(v) => setDraft((d) => ({ ...d, logo_url: v }))}
        placeholder="https://.../logo.png"
        placeholderTextColor={t.fgSubtle}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        onPress={() => void onSave()}
        disabled={!dirty || saving}
        accessibilityRole="button"
        accessibilityLabel="Save workspace settings"
        accessibilityState={{ disabled: !dirty || saving, busy: saving }}
        style={{
          marginTop: 4,
          paddingVertical: 12,
          borderRadius: 10,
          backgroundColor: t.accent,
          alignItems: "center",
          opacity: !dirty || saving ? 0.5 : 1,
          minHeight: 44,
          justifyContent: "center",
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
          {saving ? "Saving…" : "Save changes"}
        </Text>
      </Pressable>
      {/* `updated_at` / `updated_by_user_id` have always been in this payload
          and were rendered nowhere. In a multi-admin workspace "who changed
          this and when" is the first question asked. */}
      <ProvenanceLine
        updatedAt={meta.updated_at}
        updatedByUserId={meta.updated_by_user_id}
      />
    </View>
  );
}

function Notice({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {text}
      </Text>
    </View>
  );
}
