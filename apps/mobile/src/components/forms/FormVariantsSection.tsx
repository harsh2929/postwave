/**
 * FormVariantsSection — form display-optimization results, and (since the
 * desktop-parity pass) the admin verbs on them.
 *
 * Reuses the campaign A/B primitives (ResultsCard, SignificanceBadge) that
 * already existed and had no consumer outside the campaign screens, so the two
 * kinds of test in this product read the same way.
 *
 * The one thing this must never do is call a winner the data does not support.
 * The server's own floor is 200 impressions per arm — its comment says "two
 * variants at 0% vs 100% have z = +inf but tell us nothing" — so
 * `formVariantVerdict` reports "still collecting" below it regardless of the
 * z-score, and the badge follows the verdict rather than the number.
 *
 * THE VERBS (FormVariantsAdmin, split out at this file's source budget), for
 * `canAdmin` callers, all online-only:
 *  - pause / resume: `exploring ↔ paused` — the ONLY legal toggle
 *    (form_variants.go:109-123; there is no "active" status, and the desktop
 *    panel's active↔paused toggle 500s on resume — not mirrored here);
 *  - remove: DELETE, confirmed — it changes the live traffic split;
 *  - add / edit: label + traffic %, via the inline composer;
 *  - evaluate: asks the SERVER to reweight and, at |z| ≥ 1.96 with ≥200
 *    impressions per arm, promote — "promote winner" is never a client claim.
 *    PROMOTED IS TERMINAL, so a promoted arm offers no verbs.
 */
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/Card";
import { SkeletonList } from "@/components/Skeleton";
import { ResultsCard } from "@/components/abtest/ResultsCard";
import { SignificanceBadge } from "@/components/abtest/SignificanceBadge";
import { listFormVariantPromotions, listFormVariants } from "@/api/forms";
import {
  VariantAdminBar,
  VariantComposer,
  VariantTextButton,
  useVariantAdminOps,
} from "@/components/forms/FormVariantsAdmin";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import {
  formVariantVerdict,
  formVariantsErrorMessage,
  formVariantsSectionHidden,
  normalizeFormVariants,
} from "@/lib/formVariants";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function FormVariantsSection({
  id,
  canAdmin = false,
}: {
  id: string | undefined;
  /** Admin floor + online session, computed by the route. */
  canAdmin?: boolean;
}) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const formId = id ?? "";
  const variants = useQuery({
    queryKey: ["form-variants", gate.tenantId, formId],
    enabled: gate.enabled && Boolean(gate.tenantId && formId),
    queryFn: () => listFormVariants(formId),
  });
  const promotions = useQuery({
    queryKey: ["form-variant-promotions", gate.tenantId, formId],
    enabled: gate.enabled && Boolean(gate.tenantId && formId),
    queryFn: () => listFormVariantPromotions(formId),
  });
  const admin = useVariantAdminOps(formId);

  const errorStatus = variants.data?.error?.status ?? 0;
  const rows = normalizeFormVariants(variants.data?.data);
  const actionable = canAdmin && online;
  // Hidden, not shown broken — the rule and its reasons live in the lib.
  if (
    formVariantsSectionHidden({
      errorStatus,
      loading: variants.isLoading,
      rowCount: rows.length,
      actionable,
    })
  ) {
    return null;
  }

  const latestPromotion = promotions.data?.data?.[0] ?? null;
  const verdict = formVariantVerdict(rows, latestPromotion);

  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          accessibilityRole="header"
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontWeight: "500",
            fontFamily: FONT.medium,
            flex: 1,
          }}
        >
          Display variants
        </Text>
        {actionable ? (
          <VariantTextButton
            label={admin.composer?.variantId === null ? "Cancel" : "Add"}
            disabled={admin.busy}
            onPress={() =>
              admin.setComposer((open) =>
                open?.variantId === null
                  ? null
                  : { variantId: null, label: "", trafficPct: "" },
              )
            }
          />
        ) : null}
      </View>

      {variants.isLoading ? (
        <SkeletonList rows={2} lines={2} />
      ) : errorStatus !== 0 ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {formVariantsErrorMessage(
            errorStatus,
            variants.data?.error?.message,
          )}
        </Text>
      ) : rows.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          No display variants yet. Add one to A/B-test how this form is shown;
          traffic splits evenly until you set weights.
        </Text>
      ) : (
        <>
          <SignificanceBadge
            significant={verdict.significant}
            label={verdict.collecting ? "Collecting" : "95%"}
            hint={verdict.hint}
          />
          <VariantResultsList
            rows={rows}
            verdict={verdict}
            actionable={actionable}
            admin={admin}
          />
        </>
      )}

      {actionable && admin.composer ? (
        <VariantComposer
          composer={admin.composer}
          busy={admin.busy}
          onChange={admin.setComposer}
          onSave={() => void admin.onComposerSave()}
        />
      ) : null}

      {actionable && rows.length >= 2 ? (
        <VariantTextButton
          label={admin.evaluating ? "Evaluating…" : "Evaluate for a winner"}
          disabled={admin.busy}
          onPress={() => void admin.onEvaluate()}
        />
      ) : null}

      {rows.length > 0 && !actionable ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {canAdmin
            ? "Variant changes need a connection — they change what visitors see and are never queued."
            : "Creating, pausing and evaluating variants changes what visitors see, so those verbs need an admin role."}
        </Text>
      ) : null}
    </Card>
  );
}

/** The per-arm results + admin bars, split out at the complexity budget. */
function VariantResultsList({
  rows,
  verdict,
  actionable,
  admin,
}: {
  rows: ReturnType<typeof normalizeFormVariants>;
  verdict: ReturnType<typeof formVariantVerdict>;
  actionable: boolean;
  admin: ReturnType<typeof useVariantAdminOps>;
}) {
  return (
    <View style={{ gap: 10 }}>
      {rows.map((row, index) => (
        <View key={row.id} style={{ gap: 4 }}>
          <ResultsCard
            metricLabel="Conversion rate"
            isWinner={verdict.significant && verdict.leaderId === row.id}
            variant={{
              id: row.id,
              variant_index: index,
              variant_label: `${row.label} · ${row.statusLabel}`,
              sent: row.impressions,
              hits: row.submissions,
              rate: row.rate,
              is_control: index === 0,
            }}
          />
          {actionable && row.status !== "promoted" ? (
            <VariantAdminBar
              row={row}
              busy={admin.busy}
              onToggle={(pressed) => void admin.onToggle(pressed)}
              onEdit={(pressed) =>
                admin.setComposer({
                  variantId: pressed.id,
                  label: pressed.label,
                  trafficPct: String(pressed.trafficPct),
                })
              }
              onRemove={(pressed) => void admin.onRemove(pressed)}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}
