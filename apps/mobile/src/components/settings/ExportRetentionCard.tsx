/**
 * ExportRetentionCard — how long export bundles are kept, and how many may be
 * active. Rendered as the last row of DataExportsSection's card, beneath the
 * export list under "Workspace exports".
 *
 * Desktop's ExportRetentionSection edits GET/PATCH
 * /api/v1/exports/retention-policy; mobile listed the bundles and could not
 * say when they lapse or why a new request was refused at the cap.
 *
 * Every number shown is the server's (the GET recomputes storage on each
 * read). Both verbs are admin; a lower role — if this ever mounts outside the
 * admin block — reads the policy and is told who can change it. A save sends
 * only the changed fields, and a 409 capacity conflict shows the server's own
 * sentence, which names the live count the cap cannot go below.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  getExportRetentionPolicy,
  patchExportRetentionPolicy,
} from "@/api/exportRetentionPolicy";
import { QueryStates } from "@/components/QueryStates";
import { SettingsTextInput } from "@/components/settings/FormControls";
import { FieldLabel } from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  exportRetentionDirty,
  exportRetentionDraft,
  exportRetentionPatch,
  exportRetentionSaveError,
  exportRetentionSummary,
  isExportRetentionPolicy,
  type ExportRetentionDraft,
  type ExportRetentionPolicy,
} from "@/lib/exportRetentionPolicy";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export function ExportRetentionCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const canAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<ExportRetentionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const queryKey = ["export-retention-policy", gate.tenantId];

  const policyQuery = useQuery({
    queryKey,
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<ExportRetentionPolicy | null> => {
      const res = await getExportRetentionPolicy();
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return res.data;
    },
  });
  // Re-validated, not trusted: the shared cache can hold any shape.
  const policy = isExportRetentionPolicy(policyQuery.data)
    ? policyQuery.data
    : null;

  // The inputs follow the SAVED policy: a fresh read (or a successful save)
  // re-seeds them, keyed on the values so a refetch that changes nothing does
  // not clobber an edit in progress.
  const savedKey = policy
    ? `${policy.retentionDays}/${policy.maxPerTenant}/${policy.updatedAt}`
    : "";
  useEffect(() => {
    if (policy) setDraft(exportRetentionDraft(policy));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const dirty = policy && draft ? exportRetentionDirty(policy, draft) : false;

  async function onSave() {
    if (!policy || !draft || saving) return;
    const result = exportRetentionPatch(policy, draft);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    if (Object.keys(result.body).length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await patchExportRetentionPolicy(result.body);
      if (res.error) {
        const message = exportRetentionSaveError(res.error);
        setSaveError(message);
        haptics.error();
        toast({ kind: "error", message });
        return;
      }
      if (res.data) qc.setQueryData(queryKey, res.data);
      else void policyQuery.refetch();
      haptics.success();
      toast({ kind: "success", message: "Export retention policy saved." });
    } finally {
      setSaving(false);
    }
  }

  const saveDisabled = !dirty || saving;

  return (
    <View
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
      }}
    >
      <FieldLabel>Retention</FieldLabel>
      <QueryStates
        query={policyQuery}
        isEmpty={!policy}
        gate={gate}
        empty={{
          title: "No retention policy",
          description: "The server returned no export-retention policy.",
        }}
        offlineMessage="Reconnect to load the export retention policy."
        skeleton={
          <SkeletonList rows={1} lines={2} label="Loading export retention" />
        }
      >
        {policy ? (
          <>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {exportRetentionSummary(policy)}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 2,
              }}
            >
              {policy.updatedAt
                ? `Last updated ${dateTime(policy.updatedAt)}`
                : "Not yet saved — using the defaults."}
            </Text>
            {canAdmin && draft ? (
              <View style={{ gap: 10, marginTop: 12 }}>
                <SettingsTextInput
                  label="Retention days"
                  hint="7-2555 days after a bundle completes. Existing bundles keep their deadline."
                  keyboardType="number-pad"
                  value={draft.retentionDays}
                  onChangeText={(v) => setDraft({ ...draft, retentionDays: v })}
                  editable={!saving}
                />
                <SettingsTextInput
                  label="Active exports"
                  hint="1-500 queued, running, or unexpired bundles. New requests are refused at the cap."
                  keyboardType="number-pad"
                  value={draft.maxPerTenant}
                  onChangeText={(v) => setDraft({ ...draft, maxPerTenant: v })}
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
                  accessibilityLabel="Save export retention policy"
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
                    {saving ? "Saving…" : "Save policy"}
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
                  marginTop: 8,
                }}
              >
                Only workspace admins can change export retention.
              </Text>
            )}
          </>
        ) : null}
      </QueryStates>
    </View>
  );
}
