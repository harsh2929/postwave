/**
 * InboxRealityTestsPanel — a running seed-list test, and the brake for it.
 *
 * VERB#12: mobile had only the pre-send predictor (api/inboxReality.ts), so a
 * placement test already in flight — holding seed-mailbox capacity and provider
 * budget — could be neither watched nor stopped from a phone.
 *
 * Only LIVE tests are listed. A finished placement report is a desk read; a test
 * still holding seats is a resource somebody may need to release. The
 * `awaiting_delivery` copy is careful for the same reason as the SMS cancel:
 * cancelling frees the seats and cannot un-send what already went.
 */
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import {
  useCancelInboxRealityTest,
  useInboxRealityTests,
} from "@/hooks/useInboxRealityTests";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  inboxRealityTestIsLive,
  inboxRealityTestSummary,
} from "@/lib/inboxRealityTests";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function InboxRealityTestsPanel() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const gate = useOnlineQueryGate();
  const query = useInboxRealityTests();
  const cancel = useCancelInboxRealityTest();

  // Array.isArray, not `?? []`. The nullish guard admits any TRUTHY non-array
  // -- a paged `{items: []}` envelope, or the HTML an SPA fallback serves for
  // an absent upstream -- straight into the iteration below.
  const live = (Array.isArray(query.data) ? query.data : []).filter((row) =>
    inboxRealityTestIsLive(row.status),
  );
  if (live.length === 0) return null;
  const mayCancel = canAccessMinimumRole("editor", gate.effectiveRole);

  const onCancel = async (id: string, subject: string) => {
    haptics.tap();
    const ok = await confirm({
      title: "Stop this placement test?",
      message:
        "The seed mailboxes are released. Anything already delivered stays delivered, and the test produces no placement result.",
      confirmLabel: "Stop test",
      destructive: true,
    });
    if (!ok) return;
    cancel.mutate(id, {
      onSuccess: () => toast({ kind: "success", message: `Stopped “${subject}”.` }),
      onError: (err) =>
        toast({
          kind: "error",
          message: errorPresentation(err).message || "Couldn't stop the test.",
        }),
    });
  };

  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Placement tests running
      </Text>
      {live.map((test) => (
        <View
          key={test.id}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 10,
            gap: 4,
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
              {test.subject}
            </Text>
            <Pill label={test.status || "running"} tone="warning" />
          </View>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {inboxRealityTestSummary(test)}
          </Text>
          {mayCancel ? (
            <Pressable
              onPress={() => void onCancel(test.id, test.subject)}
              disabled={cancel.isPending}
              accessibilityRole="button"
              accessibilityLabel={`Stop the placement test ${test.subject}`}
              accessibilityState={{ disabled: cancel.isPending }}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: cancel.isPending ? t.fgSubtle : t.danger,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                {cancel.isPending ? "Stopping…" : "Stop test"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}
