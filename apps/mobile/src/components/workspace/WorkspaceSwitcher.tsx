/**
 * WorkspaceSwitcher — change workspace without signing out (SHELL#6).
 *
 * The gap this closes: a consultant or agency operator who covers four client
 * workspaces had exactly one way to answer a question in the second one —
 * sign out, retype a password, re-satisfy MFA, sign back in. The More screen
 * rendered the current workspace as a read-only identity card, and desktop has
 * shipped a full profile switcher for as long as anyone can remember.
 *
 * WHAT MAKES THIS SAFE RATHER THAN CONVENIENT
 *
 * A switch is a full identity transition, not a filter change. It routes
 * through `switchWorkspaceSession`, which reuses the sign-in commit — so the
 * outgoing workspace's query cache, encrypted vault, offline queue, widget
 * snapshot, Spotlight donations and saved list views are all wiped before the
 * new profile is published. Nothing about workspace A survives into B.
 *
 * Three deliberate refusals:
 *
 *   - THE CURRENT WORKSPACE IS NOT TAPPABLE. It is listed (so the user can see
 *     where they are) and marked, but it is not a button; the server would
 *     treat it as a free no-op and the UI should not invite the tap.
 *   - THE CONTROL HIDES ITSELF FOR SINGLE-WORKSPACE USERS, which is nearly
 *     everyone — but only after the list has LOADED. Hiding on absence would
 *     hide it forever for anyone whose request failed.
 *   - IT IS ONLINE-ONLY. Switching requires the server to mint a session; an
 *     offline tap is refused with a reason rather than queued, because a
 *     queued identity change is not a thing that can be meaningfully undone.
 */
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { QueryStates } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useWorkspaces } from "@/hooks/useWorkspaces";
import { announce } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  shouldOfferSwitcher,
  switchableWorkspaces,
  workspaceDisplayName,
  workspaceSubtitle,
  workspaceSwitchConsequence,
  type WorkspaceSummary,
} from "@/lib/workspaceSwitchPolicy";
import { useAuthStore } from "@/store/auth";
import { switchWorkspaceSession } from "@/store/authWorkspaceSwitch";
import { queryClient } from "@/lib/queryClient";

/** How many writes are still waiting to reach the server, or 0 if unknowable. */
function pendingMutationCount(): number {
  try {
    return queryClient.getMutationCache().getAll().length;
  } catch {
    return 0;
  }
}

export function WorkspaceSwitcher() {
  const { t } = useTheme();
  const mode = useAuthStore((s) => s.mode);
  const gate = useOnlineQueryGate();
  const workspaces = useWorkspaces();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<View>(null);

  // API-key mode holds no email identity, so there is no sibling membership to
  // enumerate: the switcher does not apply and must not render a dead control.
  if (mode !== "session") return null;
  if (!shouldOfferSwitcher(workspaces.data)) return null;

  const others = switchableWorkspaces(workspaces.data ?? []);

  return (
    <View style={{ marginHorizontal: 12, marginTop: -12, marginBottom: 24 }}>
      <Pressable
        ref={triggerRef}
        onPress={() => {
          haptics.tap();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={`Switch workspace, ${others.length} other ${
          others.length === 1 ? "workspace" : "workspaces"
        }`}
        accessibilityHint="Signs this device into another workspace you belong to"
        style={{
          minHeight: 48,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.borderSubtle,
          backgroundColor: t.surface,
          paddingHorizontal: 14,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontFamily: FONT.semibold,
            ...typeStyle("body"),
          }}
        >
          Switch workspace
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("label"),
          }}
        >
          {others.length}
        </Text>
      </Pressable>
      <WorkspaceSwitcherSheet
        visible={open}
        onClose={() => setOpen(false)}
        returnFocusRef={triggerRef}
        workspaces={workspaces}
        gateEnabled={gate.enabled}
      />
    </View>
  );
}

function WorkspaceSwitcherSheet({
  visible,
  onClose,
  returnFocusRef,
  workspaces,
  gateEnabled,
}: {
  visible: boolean;
  onClose: () => void;
  returnFocusRef: { current: unknown };
  workspaces: ReturnType<typeof useWorkspaces>;
  gateEnabled: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const rows = Array.isArray(workspaces.data) ? workspaces.data : [];

  async function onPick(
    workspace: WorkspaceSummary,
    rowRef: { current: unknown },
  ): Promise<void> {
    const name = workspaceDisplayName(workspace);
    if (!gateEnabled) {
      haptics.error();
      toast({
        kind: "error",
        message: "You're offline. Reconnect to switch workspaces.",
      });
      return;
    }
    const ok = await confirm({
      title: `Switch to ${name}?`,
      message:
        "This device signs out of the current workspace and into that one. You may be asked for your second factor.",
      confirmLabel: "Switch",
      consequence: workspaceSwitchConsequence(pendingMutationCount()),
      // LOVE#75: hand VoiceOver focus back to the row that opened the sheet
      // rather than dropping it at the top of a long agency list.
      restoreFocusTo: rowRef,
    });
    if (!ok) return;
    setSwitchingId(workspace.id);
    try {
      const result = await switchWorkspaceSession(workspace.id, name);
      haptics.success();
      const message = result.switched
        ? `Switched to ${result.workspaceName}.`
        : `Already in ${result.workspaceName}.`;
      // ToastProvider sits ABOVE PersistQueryClientProvider in the root
      // layout, so this survives the provider remount a committed switch
      // triggers — which is the only reason a confirmation is visible at all.
      toast({ kind: "success", message });
      announce(message);
      onClose();
    } catch (error) {
      haptics.error();
      const message =
        error instanceof Error ? error.message : "Couldn't switch workspace.";
      toast({ kind: "error", message });
      announce(message);
    } finally {
      setSwitchingId(null);
    }
  }

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      accessibilityLabel="Switch workspace"
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          fontFamily: FONT.display,
          ...typeStyle("title"),
          marginBottom: 4,
        }}
      >
        Switch workspace
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          ...typeStyle("bodySmall"),
          marginBottom: 16,
        }}
      >
        Switching signs this device out of the current workspace and into the
        one you pick. Offline data for the current workspace is cleared.
      </Text>

      <QueryStates
        query={workspaces}
        isEmpty={rows.length === 0}
        gate={{ enabled: gateEnabled }}
        offlineMessage="Workspace list needs a connection. You are still signed in to this one."
        empty={{
          title: "No other workspaces",
          description: "This email belongs to one workspace.",
        }}
        skeleton={<SkeletonList rows={4} />}
      >
        <View style={{ gap: 10 }}>
          {rows.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              busy={switchingId === workspace.id}
              disabled={switchingId !== null}
              onPick={onPick}
            />
          ))}
        </View>
      </QueryStates>

      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={{
          marginTop: 20,
          minHeight: 48,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontFamily: FONT.semibold,
            ...typeStyle("body"),
          }}
        >
          Close
        </Text>
      </Pressable>
    </KeyboardFormSheet>
  );
}

function WorkspaceRow({
  workspace,
  busy,
  disabled,
  onPick,
}: {
  workspace: WorkspaceSummary;
  busy: boolean;
  disabled: boolean;
  onPick: (
    workspace: WorkspaceSummary,
    rowRef: { current: unknown },
  ) => Promise<void>;
}) {
  const { t } = useTheme();
  // One ref PER ROW: React Native cannot report which element holds VoiceOver
  // focus, so "put focus back where it was" has to be plumbed explicitly, and
  // a single ref on the list would send every dismissal to the same row.
  const rowRef = useRef<View>(null);
  const name = workspaceDisplayName(workspace);
  const subtitle = workspaceSubtitle(workspace);

  const body = (
    <View style={{ flex: 1 }}>
      <Text
        numberOfLines={2}
        {...typeCap("body")}
        style={{
          color: t.fg,
          fontFamily: FONT.semibold,
          ...typeStyle("body"),
        }}
      >
        {name}
      </Text>
      {subtitle ? (
        <Text
          numberOfLines={1}
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("label"),
            marginTop: 2,
          }}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );

  const frame = {
    minHeight: 56,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: workspace.current ? t.accent : t.borderSubtle,
    backgroundColor: t.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
  };

  if (workspace.current) {
    return (
      <View
        ref={rowRef}
        accessible
        accessibilityLabel={`${name}. Current workspace.`}
        style={frame}
      >
        {body}
        <Text
          {...typeCap("badgeSmall")}
          style={{
            color: t.accent,
            fontFamily: FONT.semibold,
            ...typeStyle("badgeSmall"),
          }}
        >
          Current
        </Text>
      </View>
    );
  }

  return (
    <Pressable
      ref={rowRef}
      onPress={() => {
        void onPick(workspace, rowRef);
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Switch to ${name}`}
      accessibilityState={{ disabled, busy }}
      // Static style object: a function-style `style` on a Pressable silently
      // drops layout under NativeWind v4.
      style={{ ...frame, opacity: disabled && !busy ? 0.5 : 1 }}
    >
      {body}
      {busy ? <ActivityIndicator color={t.accent} /> : null}
    </Pressable>
  );
}
