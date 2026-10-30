/**
 * CustomFieldGovernanceSection — how close this workspace is to its
 * custom-field caps, and (for admins) the per-tenant override.
 *
 * Desktop's CustomFieldGovernance renders two usage bars against the effective
 * caps and an inline editor for owners/admins. Mobile could add custom fields
 * and be refused at the cap — 422 "12/12 custom fields used" — with no way to
 * see the ceiling before hitting it, and no way to raise it from the phone.
 *
 * Both numbers in each bar are the server's (GET recomputes usage on every
 * read); nothing is fabricated while the fetch is down. The read is viewer in
 * the manifest so everyone in the workspace sees the bars; the PUT is admin,
 * so a lower role gets the bars and a line naming who can change them. A save
 * sends ONLY the changed cap, because an omitted cap keeps its current value
 * server-side.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  getCustomFieldLimits,
  putCustomFieldLimits,
} from "@/api/customFieldLimits";
import { QueryStates } from "@/components/QueryStates";
import { SettingsTextInput } from "@/components/settings/FormControls";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  customFieldGovernanceBadge,
  customFieldGovernanceState,
  customFieldLimitReadout,
  customFieldLimitsDirty,
  customFieldLimitsDraft,
  customFieldLimitsPatch,
  customFieldLimitsSaveError,
  customFieldUsageFraction,
  customFieldUsageLine,
  isCustomFieldLimits,
  type CustomFieldLimits,
  type CustomFieldLimitsDraft,
} from "@/lib/customFieldLimits";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { isPlatformSurfaceHidden } from "@/lib/platformConfig";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** The status on the error a failed queryFn re-threw, when it carried one. */
function errorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
}

export function CustomFieldGovernanceSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const canAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<CustomFieldLimitsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const queryKey = ["custom-field-limits", gate.tenantId];

  const limitsQuery = useQuery({
    queryKey,
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    retry: (attempts: number, error: unknown) =>
      !isPlatformSurfaceHidden(errorStatus(error)) && attempts < 2,
    queryFn: async (): Promise<CustomFieldLimits | null> => {
      const res = await getCustomFieldLimits();
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return res.data;
    },
  });
  // Re-validated, not trusted: the shared cache can hold any shape.
  const limits = isCustomFieldLimits(limitsQuery.data) ? limitsQuery.data : null;

  // The inputs follow the SAVED caps: a fresh read (or a successful save)
  // re-seeds them, keyed on the values so a refetch that changes nothing does
  // not clobber an edit in progress.
  const savedKey = limits
    ? `${limits.maxCustomFields}/${limits.maxSearchableFields}`
    : "";
  useEffect(() => {
    if (limits) setDraft(customFieldLimitsDraft(limits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  async function onSave() {
    if (!limits || !draft || saving) return;
    const result = customFieldLimitsPatch(limits, draft);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    // An empty body is the server's own 400 no_fields; nothing changed, so
    // there is nothing to send.
    if (Object.keys(result.body).length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await putCustomFieldLimits(result.body);
      if (res.error) {
        const message = customFieldLimitsSaveError(res.error);
        setSaveError(message);
        haptics.error();
        toast({ kind: "error", message });
        return;
      }
      if (res.data) qc.setQueryData(queryKey, res.data);
      else void limitsQuery.refetch();
      haptics.success();
      toast({ kind: "success", message: "Custom-field caps saved." });
    } finally {
      setSaving(false);
    }
  }

  // The server is the authority on who may read this. A deployment that hides
  // the surface (403/404/501) gets no card at all rather than an error.
  if (limitsQuery.isError && isPlatformSurfaceHidden(errorStatus(limitsQuery.error))) {
    return null;
  }

  const saveDisabled =
    !limits || !draft || saving || !customFieldLimitsDirty(limits, draft);

  return (
    <>
      <SectionHeader
        title="Custom fields"
        subtitle="How many custom fields this workspace may define, and how many of them may be searchable."
      />
      <Card>
        <QueryStates
          query={limitsQuery}
          isEmpty={!limits}
          gate={gate}
          empty={{
            title: "No custom-field limits",
            description: "The server returned no custom-field limits.",
          }}
          offlineMessage="Reconnect to load the custom-field limits."
          skeleton={
            <SkeletonList rows={2} lines={1} label="Loading custom-field limits" />
          }
        >
          {limits ? (
            <View style={{ gap: 12 }}>
              <UsageBar
                label="Total fields"
                used={limits.usedCustomFields}
                max={limits.maxCustomFields}
                noun="total fields"
              />
              <UsageBar
                label="Searchable fields"
                used={limits.usedSearchableFields}
                max={limits.maxSearchableFields}
                noun="searchable fields"
              />
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {customFieldLimitReadout(limits)}
              </Text>
              {canAdmin && draft ? (
                <View style={{ gap: 10 }}>
                  <SettingsTextInput
                    label="Total fields cap"
                    hint="A whole number of custom fields this workspace may define. Lowering it never deletes a field; it refuses the next one."
                    keyboardType="number-pad"
                    value={draft.maxCustomFields}
                    onChangeText={(v) =>
                      setDraft({ ...draft, maxCustomFields: v })
                    }
                    editable={!saving}
                  />
                  <SettingsTextInput
                    label="Searchable fields cap"
                    hint="How many of those fields may be indexed for search. Each searchable field costs an index."
                    keyboardType="number-pad"
                    value={draft.maxSearchableFields}
                    onChangeText={(v) =>
                      setDraft({ ...draft, maxSearchableFields: v })
                    }
                    editable={!saving}
                  />
                  {saveError ? (
                    <Text
                      accessibilityRole="alert"
                      {...typeCap("caption")}
                      style={{
                        color: t.danger,
                        ...typeStyle("caption"),
                        fontFamily: FONT.regular,
                      }}
                    >
                      {saveError}
                    </Text>
                  ) : null}
                  <Pressable
                    onPress={() => void onSave()}
                    disabled={saveDisabled}
                    accessibilityRole="button"
                    accessibilityLabel="Save custom-field caps"
                    accessibilityState={{ disabled: saveDisabled, busy: saving }}
                    style={{
                      minHeight: 44,
                      justifyContent: "center",
                      alignItems: "center",
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: t.border,
                      backgroundColor: t.surface,
                      opacity: saveDisabled ? 0.6 : 1,
                    }}
                  >
                    <Text
                      {...typeCap("body")}
                      style={{
                        color: t.fg,
                        ...typeStyle("body"),
                        fontWeight: "700",
                        fontFamily: FONT.bold,
                      }}
                    >
                      {saving ? "Saving…" : "Save caps"}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  Only workspace admins can change custom-field caps.
                </Text>
              )}
            </View>
          ) : null}
        </QueryStates>
      </Card>
    </>
  );
}

/**
 * One used/cap bar. The bar is decorative — the same reading is in the text
 * above it — so it is hidden from the accessibility tree rather than being a
 * second, wordless announcement of the line VoiceOver just read.
 */
function UsageBar({
  label,
  used,
  max,
  noun,
}: {
  label: string;
  used: number;
  max: number;
  noun: string;
}) {
  const { t } = useTheme();
  const state = customFieldGovernanceState(used, max);
  const badge = customFieldGovernanceBadge(state);
  const tone =
    state === "at" ? t.danger : state === "near" ? t.warning : t.accent;
  const fraction = customFieldUsageFraction(used, max);
  return (
    <View style={{ gap: 6 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            flexShrink: 1,
          }}
        >
          {`${label}: ${customFieldUsageLine(used, max, noun)}`}
        </Text>
        {badge ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: tone,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
              fontWeight: "600",
            }}
          >
            {badge}
          </Text>
        ) : null}
      </View>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: t.bgSubtle,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${Math.round(fraction * 100)}%`,
            height: "100%",
            backgroundColor: tone,
          }}
        />
      </View>
    </View>
  );
}
