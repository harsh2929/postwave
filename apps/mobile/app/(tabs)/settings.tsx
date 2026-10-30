/**
 * Settings — workspace config, API connection editor, theme, push,
 * and sign-out.
 *
 * Mirrors the desktop's Settings page on a phone:
 *
 *   - API connection: edit baseUrl + apiKey + tenantId, test the
 *     connection (via a cheap GET that the SDK exposes), and persist.
 *     Editing the key writes through to SecureStore via the existing
 *     auth-store sign-in path so we keep one source of truth.
 *
 *   - Display: theme (system / light / dark) backed by the ThemeContext,
 *     plus list density and the screen a cold launch lands on. Lives in
 *     components/settings/DisplayPreferencesSection.tsx, which also states
 *     why tab ORDER is deliberately not a preference.
 *
 *   - Push: existing toggle (unchanged behaviour).
 *
 *   - Sign out / Audit log shortcut.
 */
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  Text,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { EVENTS } from "@postwave/telemetry";

import { useConfirm } from "@/components/ConfirmSheet";
import { LegalLinks } from "@/components/LegalLinks";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useToast } from "@/components/Toast";
import { ApiConnectionSection } from "@/components/settings/ApiConnectionSection";
import { SettingsAboutSection } from "@/components/settings/SettingsAboutSection";
import { PlatformConfigSection } from "@/components/settings/PlatformConfigSection";
import { AccountDeletionSection } from "@/components/settings/AccountDeletionSection";
import { ApprovalGovernanceSection } from "@/components/settings/ApprovalGovernanceSection";
import { CustomFieldGovernanceSection } from "@/components/settings/CustomFieldGovernanceSection";
import { DataExportsSection } from "@/components/settings/DataExportsSection";
import { DigestPrefsSection } from "@/components/settings/DigestPrefsSection";
import { DisplayPreferencesSection } from "@/components/settings/DisplayPreferencesSection";
import { NotificationPreferencesSection } from "@/components/settings/NotificationPreferencesSection";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import { OutboundWebhooksSection } from "@/components/settings/OutboundWebhooksSection";
import { PrivacyRequestsSection } from "@/components/settings/PrivacyRequestsSection";
import { PrivacyRetentionSection } from "@/components/settings/PrivacyRetentionSection";
import { PushDeviceSection } from "@/components/settings/PushDeviceSection";
import { PushTopicsSection } from "@/components/settings/PushTopicsSection";
import { SettingsShortcuts } from "@/components/settings/SettingsShortcuts";
import { ActiveDevicesSection } from "@/components/settings/ActiveDevicesSection";
import { PasskeysSection } from "@/components/settings/PasskeysSection";
import { DeviceApprovalSection } from "@/components/settings/DeviceApprovalSection";
import { TrustedDevicesSection } from "@/components/settings/TrustedDevicesSection";
import { DeviceProtectionSection } from "@/components/settings/DeviceProtectionSection";
import { EmailVerificationRow } from "@/components/settings/EmailVerificationRow";
import { TotpSecuritySection } from "@/components/settings/TotpSecuritySection";
import { WebhookAlertPrefsSection } from "@/components/settings/WebhookAlertPrefsSection";
import {
  Card,
  Row,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { SecurityActivitySection } from "@/components/settings/SecurityActivitySection";
import { SecurityChecklistCard } from "@/components/settings/SecurityChecklistCard";
import { SecurityPolicySection } from "@/components/settings/SecurityPolicySection";
import {
  SettingsAnchorProvider,
  useSettingsAnchorRegistry,
} from "@/components/settings/SettingsAnchors";
import { useRestoreScroll } from "@/hooks/useRestoreScroll";
import { useSettingsAnchorParam } from "@/hooks/useSettingsAnchorParam";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { SettingsFooter } from "@/components/settings/SettingsFooter";
import { SettingsIndex } from "@/components/settings/SettingsIndex";
import { ViewerModeSection } from "@/components/settings/ViewerModeSection";
import { VoiceLabelsSection } from "@/components/settings/VoiceLabelsSection";
import { WorkspaceSetupSection } from "@/components/settings/WorkspaceSetupSection";
import { WorkspaceSettingsSection } from "@/components/settings/WorkspaceSettingsSection";
import { WorkspaceRolesSection } from "@/components/settings/WorkspaceRolesSection";
import { AiPrivacyMaskingSection } from "@/components/settings/AiPrivacyMaskingSection";
import { PreferenceCenterThemeSection } from "@/components/settings/PreferenceCenterThemeSection";
import { MaintenanceWindowsSection } from "@/components/settings/MaintenanceWindowsSection";
import { confirmAndSignOut } from "@/lib/signOutFlow";
import { FONT } from "@/lib/fonts";
import {
  getNotificationPermissionGranted,
  registerForPushNotifications,
  unregisterPushNotifications,
  unregisterPushThenSignOut,
} from "@/lib/push";
import { primePushEnable } from "@/lib/pushEnableFlow";
import {
  getOptOut as getTelemetryOptOut,
  setOptOut as setTelemetryOptOut,
  track,
} from "@/lib/telemetry";
import { startSentryOnConsent, stopSentryOnRevoke } from "@/lib/sentry";
import {
  resetDirtyGuard,
  unsavedLabels,
  unsavedPrompt,
} from "@/lib/dirtyGuard";
import { goBackOrMore } from "@/lib/nav";
import { settingsCapabilities } from "@/lib/settingsCapabilities";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { getPushToken, useAuthStore } from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

/**
 * One settings-change event, structural only.
 *
 * Settings toggles emitted NOTHING, so no one could tell which controls people
 * actually use — or that a control was being turned straight back off. `value`
 * is a fixed enum token from this file, never workspace content.
 */
function trackSetting(setting: string, value: string): void {
  track(EVENTS.MOBILE_SETTING_CHANGED, { setting, kind: value });
}

export default function Settings() {
  useScreenViewed("settings");
  const { t } = useTheme();
  // Non-blocking feedback. Every one of the conversions below replaced an
  // Alert.alert — a focus-stealing modal that cost a tap to dismiss for
  // outcomes like "saved", which is exactly what desensitises users to the
  // genuinely dangerous confirms.
  const { toast } = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);

  const mode = useAuthStore((s) => s.mode);
  const session = useAuthStore((s) => s.session);
  const signOut = useAuthStore((s) => s.signOut);
  const effectiveRole = session?.effectiveRole ?? session?.role ?? null;
  // Seven capability questions answered together in lib/settingsCapabilities,
  // which also derives `hasRestrictedWorkspaceControls` from the six
  // workspace-scoped ones so a new capability cannot be added without it.
  const {
    canManageWorkspace,
    canManageNotifications,
    canManageRetention,
    canManageWebhooks,
    canManageVoiceLabels,
    canManagePrivacy,
    canManageApprovalGovernance,
    hasRestrictedWorkspaceControls,
  } = settingsCapabilities(effectiveRole, mode);

  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushToken, setPushTokenLocal] = useState<string | null>(null);
  // In-flight guard so rapid toggling can't interleave register/unregister
  // and leave the stored token + switch out of sync.
  const pushBusyRef = useRef(false);
  const [telemetryOptOut, setTelemetryOptOutState] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState(false);

  // Section index. Offsets are registered by each anchored SectionHeader as it
  // lays out, so the jump works for the sections rendered by child components
  // too without threading a ref through every one of them.
  // The same ref also restores the scroll position on return — Settings is
  // twenty sections long and used to drop you at the top every time you came
  // back from a destination it linked to.
  const scroll = useRestoreScroll("settings");
  const anchors = useSettingsAnchorRegistry();
  // Leaving mid-edit used to discard whatever had been typed, silently. The
  // three editors on this screen (API connection, Workspace, the webhook
  // create form) register their dirty state in src/lib/dirtyGuard.ts; this is
  // the one place that asks.
  const onBack = useCallback(() => {
    const prompt = unsavedPrompt(unsavedLabels());
    if (!prompt) {
      goBackOrMore();
      return;
    }
    void confirm({
      title: prompt.title,
      message: prompt.message,
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      destructive: true,
    }).then((discard) => {
      if (!discard) return;
      // Clear the flags with the navigation: leaving them set would warn again
      // on the next attempt, about edits that are already gone.
      resetDirtyGuard();
      goBackOrMore();
    });
  }, [confirm]);

  const jumpToSection = useCallback(
    (key: string) => {
      const y = anchors.offsetFor(key);
      if (y === null) {
        // Role-gated sections never mount, so they never register an offset.
        // Silently doing nothing would read as a broken control.
        toast({
          kind: "info",
          message: "That section isn't available for your workspace role.",
        });
        return;
      }
      // A few pixels of headroom so the heading isn't flush against the
      // navigation bar after the jump.
      scroll.ref.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
    },
    [anchors, scroll, toast],
  );
  useSettingsAnchorParam(anchors, jumpToSection);

  useEffect(() => {
    // Reflect the LIVE OS permission, not just a stored token: if the user
    // revoked notifications in system settings, the toggle must read OFF.
    void Promise.all([getPushToken(), getNotificationPermissionGranted()]).then(
      ([tok, granted]) => {
        setPushTokenLocal(tok);
        setPushEnabled(Boolean(tok) && granted);
      },
    );
    void getTelemetryOptOut().then((v) => setTelemetryOptOutState(v));
  }, []);

  async function togglePush(next: boolean) {
    // Ignore taps while a previous register/unregister is still resolving;
    // interleaving the two leaves the stored token and switch inconsistent.
    if (pushBusyRef.current) return;
    pushBusyRef.current = true;
    setPushEnabled(next);
    try {
      if (next) {
        // iOS spends its prompt once per install — prime it first (pushEnableFlow).
        if (!(await primePushEnable(confirm))) {
          setPushEnabled(false);
          return;
        }
        const token = await registerForPushNotifications();
        if (!token) {
          setPushEnabled(false);
          toast({
            kind: "warning",
            message:
              "Push permission denied. Enable notifications in system settings to receive server-enabled Moosewave alerts, including approval requests.",
          });
          return;
        }
        setPushTokenLocal(token);
        trackSetting("push", "on");
      } else {
        await unregisterPushNotifications();
        setPushTokenLocal(null);
        trackSetting("push", "off");
      }
    } catch {
      // registerForPushNotifications → getExpoPushTokenAsync can throw on a
      // real device (missing EAS project id, APNs registration failure), and
      // unregister can throw too; without a catch the optimistic switch flip
      // would be left desynced from reality and the error swallowed. Revert
      // the switch to its pre-toggle state and surface the failure.
      setPushEnabled(!next);
      toast({
        kind: "error",
        message: next
          ? "Couldn't enable push notifications."
          : "Couldn't disable push notifications.",
      });
    } finally {
      pushBusyRef.current = false;
    }
  }

  function onSignOut() {
    // The shared flow (src/lib/signOutFlow.ts) owns the copy, the in-flight
    // guard and the teardown order. This screen previously had its own version
    // with different copy and NO guard, so a double-tap could start two
    // unregisterPushThenSignOut flows racing on SecureStore.
    void confirmAndSignOut({
      mode,
      confirm,
      performSignOut: () => unregisterPushThenSignOut(signOut),
      onBusyChange: setSigningOut,
      navigateToSignIn: () => router.replace("/(auth)/sign-in"),
    }).then((outcome) => {
      if (outcome === "signed-out-degraded") {
        toast({
          kind: "warning",
          message:
            "Signed out on this device, but the server couldn't be reached to revoke it. It will retry.",
        });
      }
    });
  }

  /** NATIVE#49 — the recovery for a device the server has stopped delivering
   *  to. Registration is idempotent, so this is safe to repeat. */
  async function reRegisterPushDevice(): Promise<boolean> {
    const token = await registerForPushNotifications();
    setPushTokenLocal(token);
    setPushEnabled(Boolean(token));
    return Boolean(token);
  }

  async function onRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        // Everything below the Display section is server-backed — workspace,
        // notifications, retention, webhooks, devices, passkeys, privacy
        // requests, exports, plan. The pull used to refetch NOTHING of it: the
        // two device values here were the whole gesture, so a deliberate pull
        // on a twenty-section screen refreshed two switches and silently left
        // every row the user was actually looking at as it was. `type:
        // "active"` rather than a list, for the same reason the dashboard uses
        // it — an explicit list is a list somebody has to remember to update.
        qc.refetchQueries({ type: "active" }).catch(() => undefined),
        getTelemetryOptOut().then((v) => setTelemetryOptOutState(v)),
        Promise.all([getPushToken(), getNotificationPermissionGranted()]).then(
          ([tok, granted]) => {
            setPushTokenLocal(tok);
            setPushEnabled(Boolean(tok) && granted);
          },
        ),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Settings" onBack={onBack} onSearch />
      {/* This ScrollView hosts 14 text inputs (API connection, workspace,
          outbound webhooks) several thousand pixels down. Without keyboard
          avoidance the keyboard covers the field being edited AND its Save
          button — keyboardShouldPersistTaps does not scroll anything into
          view. Eleven other surfaces in the app already handle this. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          ref={scroll.ref}
          onScroll={scroll.onScroll}
          scrollEventThrottle={scroll.scrollEventThrottle}
          contentContainerStyle={{
            padding: 16,
            paddingTop: 4,
            paddingBottom: 48,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
              tintColor={t.fgMuted}
              colors={[t.accent]}
            />
          }
        >
          <SettingsAnchorProvider registry={anchors}>
            {/* Search + category jump. Twenty-plus sections in one linear scroll
              had no index at all: finding "App lock" meant thumbing past API
              connection, Appearance, Push and Privacy every time. */}
            <SettingsIndex onJump={jumpToSection} />

            {/* Account — email-auth users see their identity here. */}
            {mode === "session" && session ? (
              <>
                <SectionHeader
                  anchor="account"
                  title="Account"
                  subtitle="Signed in via email + password."
                />
                <Card>
                  <Row label="Email" value={session.email} />
                  <Row label="Role" value={session.role} />
                  <Row
                    label="Workspace"
                    value={
                      session.workspaceName
                        ? `${session.workspaceName}${session.workspaceSlug ? ` (${session.workspaceSlug})` : ""}`
                        : session.tenantId
                    }
                  />
                  <Row label="Auth provider" value={session.authProvider} />
                  <Row
                    label="Email verified"
                    value={session.emailVerified ? "Yes" : "No"}
                  />
                  {/* A bare "No" is a dead end — this row carries the resend. */}
                  <EmailVerificationRow />
                </Card>

                {/* Scores the three controls below it; see the component. */}
                <SecurityChecklistCard />

                <TotpSecuritySection />
                <DeviceApprovalSection />
                {/* Remote sign-out for other devices. Belongs directly under the
                  other security controls: the phone in your hand is the thing
                  you still have when the laptop is the thing you lost. */}
                <ActiveDevicesSection />
                <PasskeysSection />
                {/* AUTH#48 — a remembered device is NOT a session: it survives
                  logout and "sign out all other devices" does not touch it.
                  Adjacent, with its own verb, so the difference is legible. */}
                <TrustedDevicesSection />
                {/* `viewer_mode` was parsed off /me and stored on the session
                  profile since the first release, and read by nothing: an admin
                  who left the preview on from desktop opened a silently
                  read-only app. Renders null unless the role can use it. */}
                <ViewerModeSection />
                {/* Read-only tenant policy; hides itself on an admin-scope 403. */}
                <SecurityPolicySection />
                {/* AUTH#8b — the recent sign-ins / MFA changes / token grants
                  that answer "did anyone else get in?" WITHOUT sending the
                  user to a different tab to rebuild the filter by hand.
                  Renders nothing without the audit:read scope. */}
                <SecurityActivitySection />
              </>
            ) : null}

            {/* API connection. */}
            <SectionHeader
              anchor="api-connection"
              title="API connection"
              subtitle={
                mode === "session"
                  ? "Connected via session cookie. API key is optional (power-user workflows)."
                  : "Where the mobile app sends its requests."
              }
            />
            <ApiConnectionSection />

            {/* Display: theme, list density, and which screen a cold launch
              lands on. Theme used to be the ONLY display preference in a
              product whose every list is card-heavy and whose every launch
              went to Dashboard (LOVE#51). Tab ORDER is deliberately not
              offered and the section says why — see the component. */}
            <DisplayPreferencesSection onChange={trackSetting} />

            {/* Push. The card also carries the SERVER's delivery verdict, which
              is the only authority that notices when a rotated OS token has
              quietly ended delivery (NATIVE#49). */}
            <PushDeviceSection
              enabled={pushEnabled}
              token={pushToken}
              onToggle={togglePush}
              onReRegister={reRegisterPushDevice}
            />

            {/* Per-event topics. The endpoint has always taken an allowlist; the
            app sent a module constant no UI could change, so the only way to
            stop one kind of ping was to stop all of them. */}
            <SectionHeader
              anchor="push-topics"
              title="What to notify me about"
              subtitle="Choose which events may buzz this device."
            />
            <PushTopicsSection
              enabled={pushEnabled}
              // Switching the last topic off cannot be sent as an empty
              // allowlist — the server reads that as "no preference" and turns
              // its own defaults on. The honest representation of "no topics"
              // is an unregistered device, so turn the master switch off.
              onAllTopicsOff={() => {
                if (!pushEnabled) return;
                void togglePush(false);
                toast({
                  kind: "info",
                  message:
                    "Every topic is off, so push is now off for this device.",
                });
              }}
            />

            {/* Telemetry opt-out. */}
            <SectionHeader
              anchor="telemetry"
              title="Privacy"
              subtitle="Anonymous usage and crash data help us prioritise features and fix faults. No subscriber data, email content, or names are ever sent."
            />
            <Card>
              <SettingsSwitchRow
                label="Send anonymous usage and crash data"
                hint="Sends reviewed events, counts, durations, structural error codes, and crash diagnostics with the message text removed. No subscriber data, email content, or names — and no raw user or workspace identifiers."
                value={!telemetryOptOut}
                onValueChange={(next) => {
                  const optOut = !next;
                  setTelemetryOptOutState(optOut);
                  // ONE switch, both systems. Crash reporting used to start at
                  // module load regardless of this control, so the copy above
                  // described more than the switch did. Sentry now waits for
                  // this same decision at launch, which means this is also the
                  // moment it can first be started or shut down.
                  if (optOut) stopSentryOnRevoke();
                  else startSentryOnConsent();
                  void setTelemetryOptOut(optOut).then((persisted) => {
                    if (!persisted) {
                      // Persistence failed — revert the switch and surface it,
                      // matching the push / app-lock / widget toggles above so
                      // this preference can't silently revert on next launch.
                      setTelemetryOptOutState(!optOut);
                      if (optOut) startSentryOnConsent();
                      else stopSentryOnRevoke();
                      toast({
                        kind: "error",
                        message: "Couldn't save your analytics preference.",
                      });
                    }
                  });
                }}
              />
            </Card>

            {/* App lock + the iOS widget-metrics opt-in. One component: arming
              the lock revokes the widget opt-in, so the two switches share
              their state and their in-flight guard. */}
            <DeviceProtectionSection />

            <AccountDeletionSection />

            {canManagePrivacy ? (
              <>
                <SectionHeader
                  anchor="privacy-requests"
                  title="Data export and privacy requests"
                  subtitle="Queue a portable export under the right regulatory regime and track request status."
                />
                <PrivacyRequestsSection />
              </>
            ) : null}

            {/* The TENANT export subsystem — distinct from the DSAR request
              above, and previously unreachable from mobile entirely. Its
              output is a signed 24h URL, which is more actionable on a phone
              than anywhere else. Admin scope, matching the endpoint. */}
            {canManageApprovalGovernance ? (
              <>
                <SectionHeader
                  anchor="workspace-exports"
                  title="Workspace exports"
                  subtitle="Downloadable archives of this workspace's data. Links expire 24 hours after the bundle is built."
                />
                <DataExportsSection />
              </>
            ) : null}

            <SectionHeader
              anchor="legal"
              title="Legal and support"
              subtitle="Store-review links and account-data controls."
            />
            <Card>
              <LegalLinks
                align="left"
                links={[
                  { key: "privacy", label: "Privacy Policy" },
                  { key: "terms", label: "Terms" },
                  { key: "accountDeletion", label: "Delete account on web" },
                  { key: "support", label: "Support" },
                ]}
              />
              {/* Source + privacy contact — the two About rows desktop has had
                all along and mobile did not. */}
              <SettingsAboutSection />
            </Card>

            {hasRestrictedWorkspaceControls ? (
              <>
                <SectionHeader title="Workspace administration" />
                <Card>
                  <Text
                    accessibilityRole="text"
                    {...typeCap("label")}
                    style={{
                      color: t.fgMuted,
                      ...typeStyle("label"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    Administrative controls are hidden for this workspace role.
                    Personal settings remain available above; ask a workspace
                    administrator if you need to manage workspace-wide policy.
                  </Text>
                </Card>
              </>
            ) : null}

            {canManageWorkspace ? (
              <>
                <SectionHeader
                  anchor="workspace"
                  title="Workspace"
                  subtitle="Display name, reply-to address, timezone, branding."
                />
                <WorkspaceSettingsSection />
              </>
            ) : null}

            {canManageNotifications ? (
              <>
                <SectionHeader
                  anchor="email-notifications"
                  title="Notifications"
                  subtitle="Email me when something interesting happens in this workspace."
                />
                <NotificationPreferencesSection />

                <SectionHeader
                  anchor="digest"
                  title="Dashboard digest"
                  subtitle="A periodic rollup of workspace activity, emailed to you."
                />
                <DigestPrefsSection />
              </>
            ) : null}

            {canManageApprovalGovernance ? (
              <>
                <SectionHeader
                  anchor="approval-governance"
                  title="Approval governance"
                  subtitle="Escalation policy and who is currently covering approvals."
                />
                <ApprovalGovernanceSection />
              </>
            ) : null}

            {canManageRetention ? (
              <>
                <SectionHeader
                  anchor="retention"
                  title="Data retention"
                  subtitle="How long audit logs, email events, and unsubscribed records are kept."
                />
                <PrivacyRetentionSection />
              </>
            ) : null}
            <AiPrivacyMaskingSection />
            <PreferenceCenterThemeSection />

            {canManageWebhooks ? (
              <>
                <SectionHeader
                  anchor="outbound-webhooks"
                  title="Outbound webhooks"
                  subtitle="Stream subscriber + campaign events to your own services."
                />
                <OutboundWebhooksSection />

                <SectionHeader
                  anchor="webhook-alerts"
                  title="Webhook alerts"
                  subtitle="When Moosewave should tell you a destination is failing."
                />
                <WebhookAlertPrefsSection />
              </>
            ) : null}

            {canManageVoiceLabels ? (
              <>
                <SectionHeader
                  anchor="voice-labels"
                  title="Voice labels"
                  subtitle="Train the workspace voice with a sample + axis rating."
                />
                <VoiceLabelsSection />
              </>
            ) : null}

            {/* SHELL#24 — the Slack workspace grant and the sample-data seeder,
              two desktop Settings sections mobile had no equivalent for. Both
              halves gate themselves: their floors differ (slack-workspace is
              admin on BOTH verbs; sample-data reads for anyone and writes for
              admins), so the component owns the role check. */}
            <WorkspaceSetupSection />

            {/* Data residency, feature flags, the signup firewall and identifier
              transforms — four surfaces desktop has always shown and mobile
              could not see at all. Read-only, and each row hides itself when
              the SERVER says it is not this reader's to see. */}
            <PlatformConfigSection />
            {/* Usage against the custom-field caps. The 422 that refuses a new
              field names the ratio; nothing on the phone showed it BEFORE the
              refusal, and only desktop could raise the cap. */}
            <CustomFieldGovernanceSection />
            <WorkspaceRolesSection />
            <MaintenanceWindowsSection />

            {/* Plan summary + setup progress + the audit/tour shortcuts. Plan
            and setup were both invisible here: /(tabs)/billing was reachable
            only from More → Account and the onboarding checklist was
            unrecoverable once dismissed. */}
            <SettingsShortcuts />

            <SettingsFooter signingOut={signingOut} onSignOut={onSignOut} />
          </SettingsAnchorProvider>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
