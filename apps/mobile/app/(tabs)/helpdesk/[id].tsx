/**
 * Exact-admin Helpdesk thread. Outbound delivery is structurally absent.
 *
 * A thread here holds messages written by people outside the workspace, and the
 * operator reading them cannot remove them from the platform — only Moosewave
 * can. That is precisely the shape Apple Guideline 1.2 and Google Play's UGC
 * policy require a report affordance for, so the thread carries one.
 */
import { useCallback, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ErrorState } from "@/components/ErrorState";
import {
  ReportContentSheet,
  type ReportTarget,
} from "@/components/ReportContentSheet";
import { RoleGateNotice } from "@/components/RoleGateNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { HelpdeskComposer } from "@/components/helpdesk/HelpdeskComposer";
import { HelpdeskThreadActions } from "@/components/helpdesk/HelpdeskThreadActions";
import { HelpdeskThreadMessages } from "@/components/helpdesk/HelpdeskThreadMessages";
import { HelpdeskThreadNotices } from "@/components/helpdesk/HelpdeskThreadNotices";
import { useHelpdeskThreadScreen } from "@/hooks/useHelpdeskThreadScreen";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { conversationTitle } from "@/lib/helpdesk";
import { goBackOr } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function HelpdeskThread() {
  const { t } = useTheme();
  const screen = useHelpdeskThreadScreen();
  const { access, draft, id, note, noteBlocked, requestAccess, row } = screen;
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const closeReport = useCallback(() => setReportTarget(null), []);
  const openReport = useCallback(() => {
    if (!id) return;
    haptics.tap();
    setReportTarget({
      kind: "inbound_message",
      ref: id,
      label: row ? conversationTitle(row) : "This conversation",
    });
  }, [id, row]);

  if (!access.roleAllowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader
          title="Helpdesk"
          onBack={() => goBackOr("/(tabs)/helpdesk")}
        />
        <View style={{ padding: 16 }}>
          <RoleGateNotice
            title="Owner or admin session required"
            body={
              access.denialReason ??
              "This conversation was not requested for the current session."
            }
          />
        </View>
      </SafeAreaView>
    );
  }

  if (!id) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader
          title="Conversation"
          onBack={() => goBackOr("/(tabs)/helpdesk")}
        />
        <View style={{ padding: 16 }}>
          <ErrorState message="This Helpdesk link has an invalid conversation identifier. No request was sent." />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={row ? conversationTitle(row) : "Conversation"}
        {...(row?.subject ? { subtitle: row.subject } : {})}
        onBack={() => goBackOr("/(tabs)/helpdesk")}
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
        <HelpdeskThreadNotices screen={screen} />
        <HelpdeskThreadActions screen={screen} />
      </View>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <HelpdeskThreadMessages screen={screen} />
        <HelpdeskComposer
          value={draft}
          onChangeText={screen.setDraft}
          onSave={() => void screen.onSaveNote()}
          saving={note.isPending}
          enabled={requestAccess.canRequest && !noteBlocked}
          disabledNotice={screen.noteDisabledReason}
        />
      </KeyboardAvoidingView>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Pressable
          onPress={openReport}
          accessibilityRole="button"
          accessibilityLabel="Report this conversation as abusive or illegal"
          style={{
            paddingVertical: 12,
            minHeight: 44,
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("control")}
            style={{ color: t.fgMuted, fontFamily: FONT.regular, fontSize: 13 }}
          >
            Report this conversation
          </Text>
        </Pressable>
      </View>
      <ReportContentSheet target={reportTarget} onClose={closeReport} />
    </SafeAreaView>
  );
}
