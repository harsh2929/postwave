/**
 * ConnectionFamilyPanel — one panel for the provider families that share a
 * run/pause/resume/disconnect lifecycle.
 *
 * INTEG#3 (reverse-ETL write-back targets) and INTEG#5 (Klaviyo-native marketing
 * provider rows). Both had zero mobile references, and both answer the same 2am
 * question: this stopped working, can I retry it, hold it, or drop it? P2.39
 * mounts the same panel for the five non-CRM native families (analytics /
 * lead / review / loyalty / subscription) — see CONNECTION_FAMILIES.
 *
 * Verbs come from `connectionRowVerbs`, which is given the family's REAL verb
 * set — so the marketing panel never grows a Resume button, because that route
 * does not exist — and which offers NOTHING on a disconnected row, because
 * every family's list except marketing's returns those rows and every verb on
 * one answers 409 (lib/connectionRowState). The CRM family keeps its own
 * panel: its `disconnected` guard is enforced in seven handlers and in SQL,
 * and folding it in here would have meant one policy pretending to describe
 * two different contracts.
 *
 * Reads are ScopeReadReports and writes are ScopeAdmin, so a non-admin sees the
 * rows and no controls: knowing a sync is failing is worth having even when fixing
 * it is not yours to do.
 *
 * P2.40: tapping a row opens its run history (ConnectionRunHistory) — the
 * "did last night's run land, and why not" read the phone was missing. It is
 * a read at the list's own floor, so the viewer gets it too.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { ConnectionRunHistory } from "@/components/integrations/ConnectionRunHistory";
import { PanelLoadFailure } from "@/components/integrations/PanelLoadFailure";
import {
  CONNECTION_FAMILIES,
  type ConnectionFamily,
} from "@/api/connectionFamilies";
import {
  useConnectionFamily,
  useRunConnectionVerb,
} from "@/hooks/useConnectionFamily";
import {
  CONNECTION_VERB_LABELS,
  connectionVerbIsDestructive,
  type ConnectionRow,
  type ConnectionVerb,
} from "@/lib/connectionLifecycle";
import {
  connectionRowSummary,
  connectionRowTone,
  connectionRowVerbs,
  connectionVerbErrorMessage,
} from "@/lib/connectionRowState";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ConnectionFamilyPanel({
  family,
  summary,
}: {
  family: ConnectionFamily;
  /** An optional roll-up under the label — "3 destinations · 1 failing". */
  summary?: string;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const gate = useOnlineQueryGate();
  const query = useConnectionFamily(family);
  const run = useRunConnectionVerb();
  // Which row's run history is open. Declared before the early returns below:
  // hooks cannot sit behind them.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const spec = CONNECTION_FAMILIES[family];
  const rows = Array.isArray(query.data) ? query.data : [];
  // isError FIRST: a failed read leaves the same empty array as "this family has
  // no connections", and hiding the section made a 500 indistinguishable from a
  // workspace that never connected one.
  if (query.isError) {
    return (
      <PanelLoadFailure title={spec.label} subject={spec.label.toLowerCase()} />
    );
  }
  if (rows.length === 0) return null;

  const mayAct = canAccessMinimumRole("admin", gate.effectiveRole);

  const onVerb = async (row: ConnectionRow, verb: ConnectionVerb) => {
    haptics.tap();
    if (connectionVerbIsDestructive(verb)) {
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
      { family, id: row.id, verb },
      {
        onSuccess: () =>
          toast({
            kind: "success",
            message: `${CONNECTION_VERB_LABELS[verb]} — done for ${row.name}.`,
          }),
        onError: (err) =>
          toast({
            kind: "error",
            // The server's own sentence for a row-level verdict (422
            // payload_required, 409 integration_disconnected) beats a generic
            // one; errorPresentation still classifies plan / role / quota
            // refusals, so a 402 ceiling never reads as a retryable failure.
            message: connectionVerbErrorMessage(
              err,
              errorPresentation(err).message ||
                `Couldn't ${CONNECTION_VERB_LABELS[verb].toLowerCase()} ${row.name}.`,
            ),
          }),
      },
    );
  };

  return (
    <View style={{ gap: 10, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        {spec.label}
      </Text>
      {summary ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {summary}
        </Text>
      ) : null}
      {rows.map((row) => (
        <ConnectionRowCard
          key={row.id}
          family={family}
          row={row}
          verbs={mayAct ? connectionRowVerbs(spec.verbs, row.status) : []}
          busy={run.isPending}
          expanded={expandedId === row.id}
          onToggle={() =>
            setExpandedId((current) => (current === row.id ? null : row.id))
          }
          onVerb={(verb) => void onVerb(row, verb)}
        />
      ))}
    </View>
  );
}

/**
 * One connection. The name-and-status header is the disclosure for the row's
 * run history; the verbs sit beside it as their own controls so a hurried tap
 * on "Runs" can never land on "Disconnect".
 */
function ConnectionRowCard({
  family,
  row,
  verbs,
  busy,
  expanded,
  onToggle,
  onVerb,
}: {
  family: ConnectionFamily;
  row: ConnectionRow;
  verbs: ConnectionVerb[];
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onVerb: (verb: ConnectionVerb) => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        gap: 6,
      }}
    >
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${row.name}, ${row.status || "unknown"}`}
        accessibilityHint={expanded ? "Hides run history" : "Shows run history"}
        style={{ minHeight: 44, justifyContent: "center", gap: 6 }}
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
          <Pill
            label={row.status || "unknown"}
            tone={connectionRowTone(row.status)}
          />
          <Text
            {...typeCap("control")}
            style={{
              color: t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
              marginStart: "auto",
            }}
          >
            {expanded ? "Hide runs" : "Runs"}
          </Text>
        </View>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {connectionRowSummary(row)}
        </Text>
      </Pressable>
      {verbs.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
          {verbs.map((verb) => (
            <Pressable
              key={verb}
              onPress={() => onVerb(verb)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`${CONNECTION_VERB_LABELS[verb]} ${row.name}`}
              accessibilityState={{ disabled: busy }}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: busy
                    ? t.fgSubtle
                    : connectionVerbIsDestructive(verb)
                      ? t.danger
                      : t.accent,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                {CONNECTION_VERB_LABELS[verb]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {expanded ? <ConnectionRunHistory family={family} id={row.id} /> : null}
    </View>
  );
}
