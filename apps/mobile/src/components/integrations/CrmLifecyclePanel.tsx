/**
 * CrmLifecyclePanel — retry, pause, resume or disconnect a CRM connection.
 *
 * INTEG#2: mobile had no CRM lifecycle client at all, so a failing HubSpot or
 * Salesforce sync was something the phone could watch and not touch. Every route
 * here is admin/reviewed, and the panel renders nothing at all below that role
 * rather than showing controls that 403.
 *
 * Only legal verbs are offered — see crmVerbsFor, which mirrors the server's single
 * hard guard (`disconnected`) and the pause/resume pairing. Disconnect asks for
 * confirmation and is placed last, because this screen exists for hurried moments
 * and a mis-tap should not be the destructive one.
 */
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { PanelLoadFailure } from "@/components/integrations/PanelLoadFailure";
import { useCrmIntegrations, useRunCrmVerb } from "@/hooks/useCrmIntegrations";
import {
  CRM_VERB_LABELS,
  crmIsDisconnected,
  crmIsPaused,
  crmStatusSummary,
  crmVerbErrorMessage,
  crmVerbIsDestructive,
  crmVerbsFor,
  type CrmIntegrationRow,
  type CrmVerb,
} from "@/lib/crmLifecycle";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function toneFor(status: string): "warning" | "success" | "neutral" {
  if (crmIsDisconnected(status)) return "neutral";
  if (crmIsPaused(status)) return "warning";
  return "success";
}

function CrmRow({
  row,
  busy,
  onVerb,
}: {
  row: CrmIntegrationRow;
  busy: boolean;
  onVerb: (row: CrmIntegrationRow, verb: CrmVerb) => void;
}) {
  const { t } = useTheme();
  const verbs = crmVerbsFor(row.status);
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {row.name}
        </Text>
        <Pill label={row.status || "unknown"} tone={toneFor(row.status)} />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {crmStatusSummary(row)}
      </Text>
      {verbs.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
          {verbs.map((verb) => (
            <Pressable
              key={verb}
              onPress={() => onVerb(row, verb)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`${CRM_VERB_LABELS[verb]} ${row.name}`}
              accessibilityState={{ disabled: busy }}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: busy
                    ? t.fgSubtle
                    : crmVerbIsDestructive(verb)
                      ? t.danger
                      : t.accent,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                {CRM_VERB_LABELS[verb]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function CrmLifecyclePanel() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const query = useCrmIntegrations();
  const run = useRunCrmVerb();

  const rows = Array.isArray(query.data) ? query.data : [];
  // isError FIRST. Below admin the query never runs, so an empty list means "no
  // CRM connections" and not "you may not look" — but a FAILED read produces the
  // same empty list, and silently dropping the section turned a 500 into the
  // claim that this workspace has no CRM connected.
  if (query.isError) {
    return <PanelLoadFailure title="CRM connections" subject="CRM connections" />;
  }
  if (rows.length === 0) return null;

  const onVerb = async (row: CrmIntegrationRow, verb: CrmVerb) => {
    haptics.tap();
    if (crmVerbIsDestructive(verb)) {
      const ok = await confirm({
        title: `Disconnect ${row.name}?`,
        message:
          "Syncing stops immediately. Reconnecting is done from the web admin, not from here.",
        confirmLabel: "Disconnect",
        destructive: true,
      });
      if (!ok) return;
    }
    run.mutate(
      { id: row.id, verb },
      {
        onSuccess: () =>
          toast({
            kind: "success",
            message: `${CRM_VERB_LABELS[verb]} — done for ${row.name}.`,
          }),
        onError: (err) =>
          toast({
            kind: "error",
            // The family-specific code first, then the app-wide classified
            // refusal: a plan ceiling or a role denial arrives here as a 402/403
            // envelope and must not collapse into "couldn't disconnect".
            message: crmVerbErrorMessage(
              err && typeof err === "object" && "code" in err
                ? String((err as { code?: unknown }).code ?? "")
                : "",
              errorPresentation(err, {
                explicit: undefined,
              }).message ||
                `Couldn't ${CRM_VERB_LABELS[verb].toLowerCase()} ${row.name}.`,
            ),
          }),
      },
    );
  };

  return (
    <View style={{ gap: 10, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{ color: t.fgMuted, ...typeStyle("label"), fontFamily: FONT.semibold }}
      >
        CRM connections
      </Text>
      {rows.map((row) => (
        <CrmRow
          key={row.id}
          row={row}
          busy={run.isPending}
          onVerb={(r, v) => void onVerb(r, v)}
        />
      ))}
    </View>
  );
}
