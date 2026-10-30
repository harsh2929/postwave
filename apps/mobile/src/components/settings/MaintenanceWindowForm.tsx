/**
 * MaintenanceWindowForm — the page sheet that schedules a maintenance window
 * (POST /api/v1/maintenance-windows, admin).
 *
 * Validation mirrors the handler's own three rejections before the request
 * leaves the phone (lib/maintenanceWindows.ts validateMaintenanceDraft), and
 * a rejection the server still makes is shown in its own words. Times use
 * the campaign scheduler's DateTimeWheel so a window is picked the same way a
 * send is.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { createMaintenanceWindow } from "@/api/maintenanceWindows";
import { DateTimeWheel } from "@/components/campaigns/DateTimeWheel";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SettingsTextInput } from "@/components/settings/FormControls";
import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  defaultMaintenanceDraft,
  maintenanceErrorMessage,
  validateMaintenanceDraft,
  type MaintenanceDraft,
} from "@/lib/maintenanceWindows";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type TimeField = "startsAt" | "endsAt";

export function MaintenanceWindowForm({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  /** Called after a successful create so the list re-reads. */
  onCreated: () => void;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [draft, setDraft] = useState<MaintenanceDraft>(() =>
    defaultMaintenanceDraft(),
  );
  const [picking, setPicking] = useState<TimeField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A fresh draft every time the sheet opens: the previous window's title
  // must not linger into the next one.
  useEffect(() => {
    if (!visible) return;
    setDraft(defaultMaintenanceDraft());
    setPicking(null);
    setError(null);
  }, [visible]);

  async function submit() {
    if (busy) return;
    const result = validateMaintenanceDraft(draft);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createMaintenanceWindow(result.body);
      if (res.error) {
        const message = maintenanceErrorMessage(res.error);
        setError(message);
        haptics.error();
        toast({ kind: "error", message });
        return;
      }
      haptics.success();
      toast({ kind: "success", message: `Scheduled "${result.body.title}".` });
      onCreated();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const timeRow = (field: TimeField, label: string) => {
    const open = picking === field;
    return (
      <Pressable
        onPress={() => setPicking(open ? null : field)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${dateTime(draft[field])}`}
        accessibilityHint={open ? "Closes the picker." : "Opens the picker."}
        accessibilityState={{ expanded: open }}
        style={{
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.regular,
          }}
        >
          {label}
        </Text>
        <Text
          {...typeCap("callout")}
          style={{
            color: open ? t.accent : t.fgMuted,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          {dateTime(draft[field])}
        </Text>
      </Pressable>
    );
  };

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Schedule a maintenance window"
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{ color: t.fg, fontFamily: FONT.bold, ...typeStyle("title") }}
      >
        Schedule a maintenance window
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginTop: 4,
        }}
      >
        Announces planned downtime on the status page and to the components it
        names.
      </Text>
      <View style={{ gap: 12, marginTop: 16 }}>
        <SettingsTextInput
          label="Title"
          value={draft.title}
          onChangeText={(v) => setDraft({ ...draft, title: v })}
          autoCapitalize="sentences"
          editable={!busy}
        />
        <SettingsTextInput
          label="Description"
          hint="Optional. What is changing and what to expect."
          value={draft.description}
          onChangeText={(v) => setDraft({ ...draft, description: v })}
          multiline
          editable={!busy}
        />
        <SettingsTextInput
          label="Affected components"
          hint="Comma-separated, e.g. api, smtp, dashboard."
          value={draft.components}
          onChangeText={(v) => setDraft({ ...draft, components: v })}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
        />
        {timeRow("startsAt", "Starts")}
        {picking === "startsAt" ? (
          <DateTimeWheel
            value={draft.startsAt}
            onChange={(next) => setDraft({ ...draft, startsAt: next })}
            t={t}
            focusKey="startsAt"
          />
        ) : null}
        {timeRow("endsAt", "Ends")}
        {picking === "endsAt" ? (
          <DateTimeWheel
            value={draft.endsAt}
            onChange={(next) => setDraft({ ...draft, endsAt: next })}
            t={t}
            focusKey="endsAt"
          />
        ) : null}
        {error ? (
          <Text
            accessibilityRole="alert"
            {...typeCap("caption")}
            style={{
              color: t.danger,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {error}
          </Text>
        ) : null}
        <Pressable
          onPress={() => void submit()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Schedule window"
          accessibilityState={{ disabled: busy, busy }}
          style={{
            minHeight: 44,
            justifyContent: "center",
            alignItems: "center",
            borderRadius: 10,
            backgroundColor: t.accent,
            opacity: busy ? 0.6 : 1,
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
            {busy ? "Scheduling…" : "Schedule window"}
          </Text>
        </Pressable>
        <Pressable
          onPress={onClose}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Close without scheduling"
          style={{ minHeight: 44, justifyContent: "center", alignItems: "center" }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fgMuted,
              ...typeStyle("body"),
              fontFamily: FONT.regular,
            }}
          >
            Cancel
          </Text>
        </Pressable>
      </View>
    </KeyboardFormSheet>
  );
}
