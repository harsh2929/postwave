/**
 * Moosewave AI — chat, on a phone.
 *
 * Desktop's Moosewave AI is a six-mode workspace; this is its CHAT mode and
 * nothing else — Subject Lab already has its own screen, compose/pre-send/
 * agent/routines stay on the desk. The route it talks to is the same one:
 * POST /api/v1/voice/generate (apps/api/internal/aichat), editor and above,
 * write:campaigns.
 *
 * SEND → WAIT → WHOLE REPLY. That handler returns synchronous JSON for every
 * request, stream flag or not (its package doc says so in the first
 * sentence), so a reply lands as one bubble once the server is done. The
 * screen never pretends otherwise: the pending bubble says "waiting for the
 * whole reply", the disclosure banner says nothing streams, and the one
 * mid-turn control is Stop.
 *
 * WHAT GATES WHAT (lib/aiChatTranscript.aiChatAccess, most-blocking first):
 *   held      — the server answered 503 agent_interactive_release_held. The
 *               server's sentence is rendered verbatim as a blocked screen,
 *               with no composer and no retry, until Clear.
 *   no_tenant / offline — the online gate or reachability is closed. Nothing
 *               here has an offline copy: a reply is generated, not fetched.
 *   role      — below editor. The transcript stays readable, the composer
 *               explains the floor instead of 403ing.
 *
 * Article 50: the @postwave/ai-disclosure text is the FIRST transcript row
 * whenever a turn can happen or has happened (lib/aiChatTranscript's
 * aiChatTranscriptRows makes that structural), and every reply is tagged
 * AI-generated.
 *
 * History is in memory for the life of the screen — see hooks/useAiChat for
 * why this device does not write a transcript down.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AiChatAccessNotice } from "@/components/ai-chat/AiChatAccessNotice";
import { AiChatComposer } from "@/components/ai-chat/AiChatComposer";
import { AiChatDisclosureBanner } from "@/components/ai-chat/AiChatDisclosureBanner";
import { AiChatEmptyState } from "@/components/ai-chat/AiChatEmptyState";
import { AiChatMessageBubble } from "@/components/ai-chat/AiChatMessageBubble";
import {
  ReportContentSheet,
  type ReportTarget,
} from "@/components/ReportContentSheet";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useToast } from "@/components/Toast";
import { useAiChat } from "@/hooks/useAiChat";
import { useAiDraftHandoff } from "@/hooks/useAiDraftHandoff";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import type { AiChatTone } from "@/lib/aiChat";
import {
  aiChatAccess,
  aiChatTranscriptRows,
  type AiChatTranscriptRow,
} from "@/lib/aiChatTranscript";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function AiChat() {
  const { t } = useTheme();
  const { toast } = useToast();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const mode = useAuthStore((s) => s.mode);
  const chat = useAiChat();
  useScreenViewed("ai-chat");

  const [input, setInput] = useState("");
  const [tone, setTone] = useState<AiChatTone>("");
  const listRef = useRef<FlatList<AiChatTranscriptRow>>(null);
  const shouldScrollEnd = useRef(false);

  // The measured server floor: aichat.go mounts write:campaigns, the
  // routeauth manifest says session_minimum_role "editor". Not one notch
  // stricter — a client may only out-gate the server where it can say why.
  const canWrite = canAccessMinimumRole("editor", gate.effectiveRole, mode);
  const access = aiChatAccess({
    hold: chat.hold,
    hasTenant: Boolean(gate.tenantId),
    gateEnabled: gate.enabled,
    online,
    canWrite,
  });
  const ready = access.kind === "ready";
  const canAct = ready && !chat.pending;
  const rows = aiChatTranscriptRows(chat.messages, { canSend: ready });

  const handoff = useAiDraftHandoff((kind, message) => toast({ kind, message }));

  const onSend = useCallback(() => {
    const prompt = input.trim();
    if (!prompt || !ready || chat.pending) return;
    shouldScrollEnd.current = true;
    chat.send(prompt, tone);
    setInput("");
  }, [chat, input, ready, tone]);

  const onRetry = useCallback(
    (assistantId: string) => {
      shouldScrollEnd.current = true;
      chat.retry(assistantId);
    },
    [chat],
  );

  const onCopied = useCallback(() => {
    toast({ kind: "success", message: "Copied." });
  }, [toast]);

  // Reporting model output is a Google Play generative-AI policy requirement
  // and an Apple Guideline 1.2 one. The label carries a slice of the reply so
  // the sheet can show the reporter what they are about to report, and the
  // full text reaches the operator through subject_ref on the server side.
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const onReport = useCallback((assistantId: string, text: string) => {
    setReportTarget({
      kind: "ai_output",
      ref: assistantId,
      label:
        text.length > 140 ? `${text.slice(0, 140).trimEnd()}\u2026` : text,
    });
  }, []);
  const closeReport = useCallback(() => setReportTarget(null), []);

  const onClear = useCallback(() => {
    haptics.warning();
    chat.clear();
    setInput("");
  }, [chat]);

  // A reply landing is the moment to bring the newest bubble into view.
  const messageCount = chat.messages.length;
  useEffect(() => {
    if (messageCount > 0) shouldScrollEnd.current = true;
  }, [messageCount, chat.pending]);

  const subtitle =
    access.kind === "held"
      ? "Blocked on the server"
      : access.kind === "offline" || access.kind === "no_tenant"
        ? "Offline · reconnect to ask"
        : access.kind === "role"
          ? "Read-only below editor"
          : "Replies arrive whole, not streamed";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Moosewave AI"
        subtitle={subtitle}
        onBack={goBackOrMore}
        right={
          chat.messages.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear the conversation"
              accessibilityHint="Removes every message on this device"
              onPress={onClear}
              hitSlop={8}
              style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("control"),
                  fontFamily: FONT.medium,
                }}
              >
                Clear
              </Text>
            </Pressable>
          ) : undefined
        }
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={(row) => row.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 8, flexGrow: 1 }}
          {...MOBILE_LIST_PERF_PROPS}
          onContentSizeChange={() => {
            if (!shouldScrollEnd.current) return;
            shouldScrollEnd.current = false;
            listRef.current?.scrollToEnd({ animated: true });
          }}
          ListHeaderComponent={
            <AiChatAccessNotice access={access} hold={chat.hold} />
          }
          ListFooterComponent={
            ready && chat.messages.length === 0 ? (
              <AiChatEmptyState
                onPick={(starter) => {
                  setInput(starter);
                }}
              />
            ) : null
          }
          renderItem={({ item }) =>
            item.kind === "disclosure" ? (
              <AiChatDisclosureBanner text={item.text} />
            ) : (
              <AiChatMessageBubble
                message={item.message}
                canAct={canAct}
                onRetry={onRetry}
                onCreateDraft={handoff.create}
                creatingDraft={handoff.creating}
                onCopied={onCopied}
                onReport={onReport}
              />
            )
          }
        />
        <AiChatComposer
          value={input}
          onChangeText={setInput}
          tone={tone}
          onToneChange={setTone}
          pending={chat.pending}
          enabled={ready}
          disabledReason={access.kind === "ready" ? null : access.message}
          onSend={onSend}
          onStop={chat.stop}
        />
      </KeyboardAvoidingView>
      <ReportContentSheet target={reportTarget} onClose={closeReport} />
    </SafeAreaView>
  );
}
