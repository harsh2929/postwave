/**
 * AiPrivacyMaskingSection — which subscriber fields are masked from AI models.
 *
 * Moosewave tokenizes PII before a subscriber field is placed in a model
 * prompt and detokenizes the reply. Desktop's DataPrivacySection is the
 * per-tenant control plane for that; mobile had no caller for
 * /api/v1/settings/pii-config, so an operator could not see — let alone
 * change — which fields reach a model from the phone.
 *
 * Role: both verbs are admin in the routeauth manifest, so this renders
 * nothing for anyone below admin (the screen's "administrative controls are
 * hidden" notice already explains that). Built-in identifiers (email, phone)
 * are always masked and their toggle is locked on; custom fields flip one
 * PATCH at a time.
 *
 * Hides itself when the server answers 503 pii_gateway_unconfigured (or the
 * route is absent): a deployment without the gateway is a product boundary,
 * not an error for the operator to retry.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";

import { getPiiMaskingConfig, patchPiiMaskingConfig } from "@/api/aiPiiMasking";
import { QueryStates } from "@/components/QueryStates";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  isPiiGatewayUnavailable,
  piiFieldLocked,
  piiMaskPatchBody,
  piiMaskedSummary,
  piiSaveErrorMessage,
  type PiiFieldView,
  type PiiMaskingConfig,
} from "@/lib/aiPiiMasking";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export function AiPrivacyMaskingSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const canAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const qc = useQueryClient();
  const { toast } = useToast();
  // field currently being PATCHed; locks every toggle so two flips cannot
  // interleave and leave the card out of step with the server.
  const [savingField, setSavingField] = useState<string | null>(null);
  const queryKey = ["settings-ai-pii-masking", gate.tenantId];

  const config = useQuery({
    queryKey,
    enabled: canAdmin && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    // An unconfigured gateway is a final answer, not a transient to hammer.
    retry: (count, error) => !isPiiGatewayUnavailable(error) && count < 2,
    queryFn: async (): Promise<PiiMaskingConfig> => {
      const res = await getPiiMaskingConfig();
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return res.data;
    },
  });

  if (!canAdmin) return null;
  if (config.isError && isPiiGatewayUnavailable(config.error)) return null;

  // A truthy non-array from the wire (paged envelope, HTML fallback) must
  // not reach `.map`; `?? []` would pass it straight through.
  const wireFields = config.data?.fields;
  const fields = Array.isArray(wireFields) ? wireFields : [];

  async function onToggle(field: PiiFieldView, next: boolean) {
    if (savingField !== null || piiFieldLocked(field, canAdmin)) return;
    setSavingField(field.fieldName);
    try {
      const res = await patchPiiMaskingConfig(
        piiMaskPatchBody(field.fieldName, next),
      );
      if (res.error) {
        haptics.error();
        toast({ kind: "error", message: piiSaveErrorMessage(res.error) });
        return;
      }
      // The PATCH answers the whole new config — it IS the fresh read.
      qc.setQueryData(queryKey, res.data);
      haptics.success();
      toast({
        kind: "success",
        message: next
          ? `"${field.fieldName}" is now masked from AI models.`
          : `"${field.fieldName}" is no longer masked from AI models.`,
      });
    } finally {
      setSavingField(null);
    }
  }

  return (
    <>
      <SectionHeader
        title="AI privacy"
        subtitle="Subscriber fields are tokenized before they reach an AI model and restored in its reply. Choose which custom fields are masked."
      />
      <Card>
        <QueryStates
          query={config}
          isEmpty={fields.length === 0}
          gate={gate}
          empty={{
            title: "No subscriber fields configured yet",
            description:
              "Built-in identifiers (email, phone) are always masked from AI models.",
          }}
          offlineMessage="Reconnect to load AI privacy settings."
          skeleton={
            <SkeletonList rows={3} lines={1} label="Loading AI privacy settings" />
          }
        >
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginBottom: 4,
            }}
          >
            {piiMaskedSummary(fields)}
          </Text>
          <View style={{ gap: 4 }}>
            {fields.map((field) => (
              <SettingsSwitchRow
                key={field.fieldName}
                label={field.fieldName}
                {...(field.builtIn
                  ? { hint: "Built-in identifier — always masked." }
                  : {})}
                value={field.sensitive}
                disabled={
                  piiFieldLocked(field, canAdmin) || savingField !== null
                }
                onValueChange={(next) => void onToggle(field, next)}
              />
            ))}
          </View>
          {/* Tokenized-prompt auditing is logs-only by backend design — no
              client-facing toggle exists, so say so rather than imply one. */}
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 10,
            }}
          >
            Tokenized-prompt auditing is recorded to server logs only; there is
            no client-facing audit toggle.
          </Text>
        </QueryStates>
      </Card>
    </>
  );
}
