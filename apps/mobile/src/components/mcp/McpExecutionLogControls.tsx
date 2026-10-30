/**
 * McpExecutionLogControls — the tool-filter chips above the execution log and
 * the "Load older" footer below it. Pure presentation; the screen owns the
 * filter, the traversal lives in hooks/useMcpExecutionLog.
 *
 * CHIPS, NOT A TEXT FIELD. The desktop's filter is an "Exact tool identifier"
 * input because a desktop operator can type one from memory. On a phone the
 * identifiers that matter are the ones in front of you, so the chips are the
 * tools seen in the loaded rows — and they stay once seen, or choosing one
 * would hide every way back. The chosen value is sent to the server as
 * `?tool=`; the caption says so, because "N loaded" under a server filter is
 * a count of loaded matches, not of calls.
 *
 * FOLDED WHILE UNUSED. A workspace with twenty tools would push the log a
 * screen down behind a control most readings never touch, so the chips sit
 * behind a disclosure — and the caption naming what the log is a list OF stays
 * outside it, visible either way. An ACTIVE filter is never folded away: the
 * disclosure is offered only while the log is unfiltered, so there is no state
 * in which the log is narrowed and its control is out of sight.
 *
 * THE FOOTER SAYS WHICH OF FOUR THINGS IS TRUE: a page can be asked for (and
 * which cursor it starts before), one is in flight, the traversal is done
 * ("no older matching rows were returned" — the desktop's sentence, which
 * carefully does not say "there are none"), or this view stopped asking.
 * Offline is its own line rather than a button that silently does nothing.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ChipRow } from "@/components/ChipRow";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import {
  MCP_ALL_TOOLS_LABEL,
  MCP_LOAD_OLDER_BUSY,
  MCP_LOAD_OLDER_LABEL,
  MCP_LOADING_OLDER_LABEL,
  MCP_OLDER_EXHAUSTED,
  MCP_OLDER_NOT_ADDED,
  MCP_OLDER_OFFLINE,
  MCP_RETENTION_CAP_TITLE,
  mcpNextCursorSentence,
  mcpRetentionCapSentence,
  mcpToolChipLabel,
  mcpToolFilterSentence,
} from "@/lib/mcpExecutionLog";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function McpToolFilterChips({
  tools,
  active,
  loaded,
  onChange,
}: {
  tools: readonly string[];
  /** "" for every tool. */
  active: string;
  /** Rows currently on screen, for the caption. */
  loaded: number;
  onChange: (tool: string) => void;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((was) => !was), []);
  if (tools.length === 0) return null;
  // An ACTIVE filter is never folded away: the chips are the only way back to
  // the other identifiers, and a narrowed log whose control is hidden reads as
  // a log that is simply short. So the disclosure is offered only while the
  // log is unfiltered, and there is never a control that does nothing.
  const expanded = open || active !== "";
  return (
    <View style={{ marginTop: 8 }}>
      {active === "" ? (
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel="Filter calls by tool identifier"
          accessibilityHint="Shows one chip per tool identifier seen in the loaded calls"
          accessibilityState={{ expanded }}
          style={{
            minHeight: 44,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 8,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.semibold,
            }}
          >
            Filter by tool
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {expanded ? "Hide" : `${plural(tools.length, "identifier")} seen`}
          </Text>
        </Pressable>
      ) : null}
      {expanded ? (
        <ChipRow<string>
          options={[
            {
              value: "",
              label: MCP_ALL_TOOLS_LABEL,
              accessibilityLabel: MCP_ALL_TOOLS_LABEL,
            },
            ...tools.map((name) => ({
              value: name,
              // Not the bare identifier: the rows below render that exact
              // string, and a filter that reads identically to a record is
              // ambiguous (lib/mcpExecutionLog.mcpToolChipLabel).
              label: mcpToolChipLabel(name),
              accessibilityLabel: mcpToolChipLabel(name),
            })),
          ]}
          value={active}
          onChange={onChange}
          accessibilityLabel="Tool identifiers seen in the loaded calls"
          paddingHorizontal={0}
        />
      ) : null}
      <Text
        {...typeCap("caption")}
        accessibilityLiveRegion="polite"
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 6,
        }}
      >
        {mcpToolFilterSentence(active, loaded)}
      </Text>
    </View>
  );
}

function Caption({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        textAlign: "center",
      }}
    >
      {text}
    </Text>
  );
}

function Note({ title, body }: { title: string; body: string }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="summary"
      style={{
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginBottom: 8,
        backgroundColor: t.surface,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
      >
        {title}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
      >
        {body}
      </Text>
    </View>
  );
}

export function McpLoadOlderFooter({
  online,
  loaded,
  hasNextPage,
  nextBeforeId,
  isFetchingNextPage,
  error,
  retentionCapped,
  onLoadMore,
}: {
  online: boolean;
  /** Rows currently on screen; the footer is silent under an empty log. */
  loaded: number;
  hasNextPage: boolean;
  nextBeforeId: number | null;
  isFetchingNextPage: boolean;
  error: unknown;
  retentionCapped: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTheme();
  if (loaded === 0) return null;

  let tail;
  if (retentionCapped) {
    tail = (
      <Note
        title={MCP_RETENTION_CAP_TITLE}
        body={mcpRetentionCapSentence(loaded)}
      />
    );
  } else if (!online) {
    tail = <Caption text={MCP_OLDER_OFFLINE} />;
  } else if (hasNextPage && nextBeforeId !== null) {
    tail = (
      <>
        <Pressable
          onPress={onLoadMore}
          disabled={isFetchingNextPage}
          accessibilityRole="button"
          accessibilityLabel={
            isFetchingNextPage ? MCP_LOADING_OLDER_LABEL : MCP_LOAD_OLDER_LABEL
          }
          accessibilityHint={
            isFetchingNextPage
              ? MCP_LOAD_OLDER_BUSY
              : mcpNextCursorSentence(nextBeforeId)
          }
          accessibilityState={{
            disabled: isFetchingNextPage,
            busy: isFetchingNextPage,
          }}
          style={{
            alignSelf: "center",
            minHeight: 44,
            paddingVertical: 10,
            paddingHorizontal: 18,
            justifyContent: "center",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.surface,
            opacity: isFetchingNextPage ? 0.6 : 1,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {isFetchingNextPage ? MCP_LOADING_OLDER_LABEL : MCP_LOAD_OLDER_LABEL}
          </Text>
        </Pressable>
        <View style={{ height: 6 }} />
        <Caption
          text={
            isFetchingNextPage
              ? MCP_LOAD_OLDER_BUSY
              : mcpNextCursorSentence(nextBeforeId)
          }
        />
      </>
    );
  } else {
    tail = <Caption text={MCP_OLDER_EXHAUSTED} />;
  }

  return (
    <View style={{ marginTop: 4, marginBottom: 12 }}>
      {error !== null && error !== undefined ? (
        <Note
          title={MCP_OLDER_NOT_ADDED}
          body={error instanceof Error && error.message ? error.message : "Request failed"}
        />
      ) : null}
      {tail}
    </View>
  );
}
