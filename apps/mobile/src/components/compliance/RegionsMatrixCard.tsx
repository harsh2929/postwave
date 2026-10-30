/**
 * RegionsMatrixCard — which privacy framework applies in which market, with
 * the add/remove verbs desktop's RegionsCard carries.
 *
 * REMOVE CONFIRMS, PLAIN (no typed phrase): deleting a region row changes
 * which obligations the sender applies in that market, but the row can be
 * re-added in ten seconds — the confirm exists so the consequence is read,
 * not to slow an emergency.
 *
 * Both writes are ONLINE-ONLY (see api/privacyPortal.ts): a region rule
 * replayed from an outbox hours later would change consent policy out of the
 * operator's sight.
 *
 * NativeWind v4: static style objects only.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { settingsInputStyle } from "@/components/settings/FormControls";
import { useComplianceCardStyle } from "@/components/compliance/complianceEvidenceStyle";
import {
  useCreatePrivacyRegion,
  useDeletePrivacyRegion,
} from "@/hooks/usePrivacyPortalOps";
import {
  PRIVACY_FRAMEWORKS,
  regionInputIssue,
  regionObligationsLine,
  type PrivacyRegionRow,
} from "@/lib/privacyPortalOps";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function RegionsMatrixCard({
  regions,
}: {
  regions: readonly PrivacyRegionRow[];
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const styles = useComplianceCardStyle();
  const create = useCreatePrivacyRegion();
  const remove = useDeletePrivacyRegion();

  const [code, setCode] = useState("");
  const [framework, setFramework] = useState<string>("gdpr");
  const [doi, setDoi] = useState(false);
  const [explicit, setExplicit] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const busy = create.isPending || remove.isPending;

  const onAdd = () => {
    const problem = regionInputIssue(code, framework);
    if (problem) {
      setIssue(problem);
      return;
    }
    setIssue(null);
    haptics.tap();
    create.mutate(
      {
        regionCode: code,
        framework,
        requiresDoubleOptIn: doi,
        requiresExplicitConsent: explicit,
        doNotSellDefault: false,
        gpcHonored: framework === "ccpa",
      },
      {
        onSuccess: () => {
          setCode("");
          toast({ kind: "success", message: "Region added to the matrix." });
        },
        onError: (err) => {
          const codeStr = (err as { code?: string }).code;
          setIssue(
            codeStr === "region_conflict"
              ? "That region is already in the matrix."
              : (err as Error).message || "The region could not be added.",
          );
        },
      },
    );
  };

  const onRemove = async (row: PrivacyRegionRow) => {
    const confirmed = await confirm({
      title: `Remove ${row.regionCode}?`,
      message: `${row.framework.toUpperCase()} obligations will no longer be applied for ${row.regionCode}. The row can be re-added at any time.`,
      confirmLabel: "Remove region",
      destructive: true,
    });
    if (!confirmed) return;
    remove.mutate(row.id, {
      onSuccess: () =>
        toast({ kind: "success", message: `${row.regionCode} removed.` }),
      onError: (err) =>
        toast({
          kind: "error",
          message:
            (err as { status?: number }).status === 403
              ? "Only an owner or admin can change the region matrix."
              : (err as Error).message || "The region could not be removed.",
        }),
    });
  };

  return (
    <View>
      {regions.length === 0 ? (
        <Text {...typeCap("caption")} style={styles.note}>
          No regions configured — no market-specific framework is being
          applied. Add the markets this workspace sends into.
        </Text>
      ) : null}
      {regions.map((row) => (
        <View
          key={row.id}
          style={styles.card}
          accessible
          accessibilityLabel={`Region ${row.regionCode}, framework ${row.framework}`}
        >
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
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
                {`${row.regionCode} · ${row.framework.toUpperCase()}`}
              </Text>
              <Text {...typeCap("caption")} style={styles.note}>
                {regionObligationsLine(row)}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove region ${row.regionCode}`}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => void onRemove(row)}
              hitSlop={8}
              style={{ paddingHorizontal: 8, paddingVertical: 6 }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.danger,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.medium,
                }}
              >
                Remove
              </Text>
            </Pressable>
          </View>
        </View>
      ))}

      {/* The only text field in the form: the framework and the two consent
        flags are chips. So the return key is terminal — it runs the same add
        the button does, and stays capped (but unwired) while a write is in
        flight so the keyboard does not change shape under the user. */}
      <TextInput
        {...typeCap("body")}
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="Region code (e.g. EU, CA, BR)"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Region code"
        {...keyboardChain({ onSubmit: onAdd, disabled: busy })}
        style={{ ...settingsInputStyle(t), marginTop: 4 }}
      />
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
          marginTop: 8,
        }}
      >
        {PRIVACY_FRAMEWORKS.map((fw) => (
          <Chip
            key={fw}
            label={fw.toUpperCase()}
            active={framework === fw}
            onPress={() => setFramework(fw)}
            accessibilityLabel={`Framework ${fw.toUpperCase()}`}
          />
        ))}
      </View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
          marginTop: 8,
        }}
      >
        <Chip
          label="Double opt-in"
          active={doi}
          onPress={() => setDoi((v) => !v)}
          accessibilityLabel="Requires double opt-in"
        />
        <Chip
          label="Explicit consent"
          active={explicit}
          onPress={() => setExplicit((v) => !v)}
          accessibilityLabel="Requires explicit consent"
        />
      </View>
      {issue ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          {issue}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add region to the matrix"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={onAdd}
        style={{
          minHeight: 44,
          justifyContent: "center",
          alignItems: "center",
          borderRadius: 10,
          marginTop: 8,
          backgroundColor: busy ? t.bgSubtle : t.accent,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: busy ? t.fgMuted : t.accentFg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          Add region
        </Text>
      </Pressable>
    </View>
  );
}
