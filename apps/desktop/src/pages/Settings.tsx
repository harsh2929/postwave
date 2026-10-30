/**
 * Settings — API config, theme (locked dark), about, sign out.
 */

import {
  Suspense,
  lazy,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { AIRegressionSettings } from "../components/ai/AIRegressionSettings";
import { ConfirmModal } from "../components/ConfirmModal";
import { DigestPrefsSection } from "../components/dashboard/DigestPrefsSection";
import { InlineHelp } from "../components/InlineHelp";
import { AlertPrefsSection } from "../components/webhooks/AlertPrefsSection";
import { useTour } from "../components/tour/TourProvider";
import { TotpSetupModal } from "../components/TotpSetupModal";
import { toast } from "../components/Toast";
import { LegalLinks } from "../components/LegalLinks";

const OnboardingTour = lazy(() =>
  import("../components/OnboardingWizard").then((module) => ({
    default: module.OnboardingTour,
  })),
);
import {
  NotificationsSection,
  RetentionSection,
  RolesSection,
  WorkspaceProfileSection,
} from "../components/settings/sections";
import { DataExportsSection } from "../components/settings/DataExportsSection";
import { FeatureFlagsSection } from "../components/settings/FeatureFlagsSection";
import { FirewallSection } from "../components/settings/FirewallSection";
import { ExportRetentionSection } from "../components/settings/ExportRetentionSection";
import { DesktopUpdateSettings } from "../components/settings/DesktopUpdateSettings";
import { DesktopWindowSettings } from "../components/settings/DesktopWindowSettings";
import { AccountSecuritySection } from "../components/settings/AccountSecuritySection";
import { DeviceApprovalSection } from "../components/settings/DeviceApprovalSection";
import { KeyboardShortcutsSection } from "../components/settings/KeyboardShortcutsSection";
import { SettingsNavigator } from "../components/settings/SettingsNavigator";
import { ApiKeysSection } from "../components/settings/ApiKeysSection";
import { CustomFieldGovernance } from "../components/settings/CustomFieldGovernance";
import { DataPrivacySection } from "../components/settings/DataPrivacySection";
import { IdentifierTransformsSection } from "../components/settings/IdentifierTransformsSection";
import { InactiveKeysCard } from "../components/settings/InactiveKeysCard";
import { PlanSummaryCard } from "../components/settings/PlanSummaryCard";
import { RegionSection } from "../components/settings/RegionSection";
import { ApprovalChainSection } from "../components/settings/ApprovalChainSection";
import { ArchiveDomainSection } from "../components/settings/ArchiveDomainSection";
import { UsageSection } from "../components/settings/UsageSection";
import { WebhookAdministrationSummary } from "../components/settings/WebhookAdministrationSummary";
import {
  apiAuth,
  disconnectSlack,
  getApiKey,
  getApiUrl,
  getSampleDataStatus,
  getSlackAvailability,
  getSlackConnection,
  listPrivacyRequests,
  rememberSession,
  removeSampleData,
  requestAccountDeletion,
  requestDataExport,
  seedSampleDataStrict,
  setApiConfig,
  slackOAuthStartUrl,
  safeSlackOAuthStartUrl,
  validateApiConnection,
  type AuthMeResponse,
  type PrivacyRequestRecord,
  type SampleDataStatus,
  type SlackAvailability,
  type SlackConnection,
} from "../lib/api-client";
import { hasRememberedSession, redact, requestFullSignOut } from "../lib/auth";
import { DEFAULT_API_URL } from "../lib/config";
import { useDesktopRoute } from "../lib/desktop-router";
import { useSettingsAnchorFocus } from "../lib/settings-anchor-focus";
import {
  deriveSampleBadge,
  deriveSlackGate,
  formatSampleCounts,
} from "../lib/settings-gates";
import {
  loadMe,
  setThemePreference,
  useCanAdmin,
  useTheme,
  useThemePreference,
} from "../lib/store";
import { tauriApi } from "../lib/tauri";
import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import {
  getOptOut as getTelemetryOptOut,
  setOptOut as setTelemetryOptOut,
} from "../lib/telemetry";

/**
 * `pendingConfirm` is the shared dialog model that replaces every
 * `window.confirm` in the page. Each action that used to gate on a
 * native confirm sets a config here; the single <ConfirmModal /> at
 * the bottom of the page renders it. This pattern lets the operator
 * see consistent typography, Esc / backdrop-close behaviour, and
 * (where set) type-to-confirm ceremony for irreversible ops.
 */
interface PendingConfirm {
  title: string;
  description?: string;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
  run: () => void | Promise<void>;
}

interface SettingsSetupStep {
  key: string;
  label: string;
  done: boolean;
}

function describeSettingsFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function buildSettingsSetupSteps({
  themePreference,
  apiKey,
  email,
  totpEnabled,
}: {
  themePreference: string;
  apiKey: string;
  email?: string;
  totpEnabled?: boolean;
}): SettingsSetupStep[] {
  // Reading the preference keeps this derivation reactive even when changing
  // System → explicit does not change the currently resolved palette.
  void themePreference;
  let themePicked = false;
  try {
    const persisted = window.localStorage.getItem("postwave_theme");
    themePicked =
      persisted === "system" || persisted === "light" || persisted === "dark";
  } catch {
    // Storage denial leaves this optional milestone incomplete.
  }
  return [
    {
      key: "api",
      label: "API connection",
      done: Boolean(apiKey) || Boolean(email),
    },
    { key: "auth", label: "Signed in", done: Boolean(email) },
    {
      key: "2fa",
      label: "2-step verification",
      done: Boolean(totpEnabled),
    },
    { key: "theme", label: "Theme picked", done: themePicked },
  ];
}

function AppearanceSettings(): ReactElement {
  const theme = useTheme();
  const preference = useThemePreference();
  return (
    <div className="settings-section" data-settings-anchor="appearance">
      <div className="settings-section-head">
        <h2 className="settings-section-title" id="settings-appearance-title">
          Appearance
        </h2>
        <div className="settings-section-sub" id="settings-appearance-help">
          Applies instantly across open windows. System follows operating system
          changes live.
        </div>
      </div>
      <div
        className="settings-section-body"
        role="radiogroup"
        aria-labelledby="settings-appearance-title"
        aria-describedby="settings-appearance-help"
      >
        {(["system", "light", "dark"] as const).map((choice) => (
          <div className="settings-row" key={choice}>
            <label className="radio-row">
              <input
                type="radio"
                name="pw-theme"
                checked={preference === choice}
                onChange={() => setThemePreference(choice)}
              />
              {choice === "system"
                ? `System (recommended) · currently ${theme}`
                : choice[0].toUpperCase() + choice.slice(1)}
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsSetupProgress({
  steps,
}: {
  steps: SettingsSetupStep[];
}): ReactElement {
  const completed = steps.filter((step) => step.done).length;
  const total = steps.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div
      className="settings-section"
      data-settings-anchor="setup-progress"
      aria-label={`Setup ${completed} of ${total} complete`}
    >
      <div
        className="settings-section-body"
        style={{ paddingTop: 12, paddingBottom: 12 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 8,
          }}
        >
          <div className="row" style={{ gap: 0 }}>
            <h2
              className="settings-section-title"
              style={{ fontSize: 13, fontWeight: 600, margin: 0 }}
            >
              Setup progress
            </h2>
            <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
              {completed} of {total} complete
            </span>
          </div>
          <span
            className={`badge${completed === total ? " success" : ""}`}
            style={{ fontSize: 11 }}
          >
            {percent}%
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Workspace setup progress"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{
            height: 6,
            borderRadius: 3,
            background: "var(--pw-border)",
            overflow: "hidden",
            marginBottom: 10,
          }}
        >
          <div
            style={{
              width: `${percent}%`,
              height: "100%",
              background:
                completed === total ? "var(--pw-success)" : "var(--pw-accent)",
            }}
          />
        </div>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 12 }}
        >
          {steps.map((step) => (
            <span
              key={step.key}
              className={`chip${step.done ? " is-active" : ""}`}
              title={step.done ? "Configured" : "Not yet configured"}
              style={{ cursor: "default" }}
            >
              <span aria-hidden style={{ marginRight: 4 }}>
                {step.done ? "✓" : "·"}
              </span>
              {step.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function useSettingsBootstrap(): {
  version: string;
  me: AuthMeResponse | null;
  setMe: (value: AuthMeResponse | null) => void;
  identityLoaded: boolean;
  identityErr: string | null;
  privacyRequests: PrivacyRequestRecord[];
  setPrivacyRequests: (value: PrivacyRequestRecord[]) => void;
  privacyErr: string | null;
  setPrivacyErr: (value: string | null) => void;
  privacyLoaded: boolean;
} {
  const [version, setVersion] = useState("0.1.0");
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [identityErr, setIdentityErr] = useState<string | null>(null);
  const [privacyRequests, setPrivacyRequests] = useState<
    PrivacyRequestRecord[]
  >([]);
  const [privacyErr, setPrivacyErr] = useState<string | null>(null);
  const [privacyLoaded, setPrivacyLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const result = await tauriApi.getAppVersion();
        if (mounted && result?.version) setVersion(result.version);
      } catch {
        // Keep the packaged fallback when the native bridge is unavailable.
      }
    })();
    void (async () => {
      try {
        const result = await apiAuth.getAuthMe();
        if (!mounted) return;
        if (result.data) {
          setMe(result.data);
          setIdentityErr(null);
          rememberSession(result.data);
        } else {
          setIdentityErr(result.error.message);
        }
      } catch (error) {
        if (mounted) {
          setIdentityErr(
            describeSettingsFailure(error, "Couldn't load account security."),
          );
        }
      } finally {
        if (mounted) setIdentityLoaded(true);
      }
    })();
    void (async () => {
      try {
        const result = await listPrivacyRequests();
        if (!mounted) return;
        if (result.error) {
          setPrivacyErr(result.error.message);
        } else {
          setPrivacyErr(null);
          setPrivacyRequests(
            Array.isArray(result.data.requests) ? result.data.requests : [],
          );
        }
      } catch (error) {
        if (mounted) {
          setPrivacyErr(
            describeSettingsFailure(
              error,
              "Couldn't load privacy request history.",
            ),
          );
        }
      } finally {
        if (mounted) setPrivacyLoaded(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return {
    version,
    me,
    setMe,
    identityLoaded,
    identityErr,
    privacyRequests,
    setPrivacyRequests,
    privacyErr,
    setPrivacyErr,
    privacyLoaded,
  };
}

function useApiConnectionSettings(): {
  url: string;
  setUrl: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  testing: boolean;
  saving: boolean;
  testState: "idle" | "ok" | "fail";
  testMsg: string;
  onTest: () => Promise<void>;
  onSave: () => Promise<void>;
} {
  const [url, setUrl] = useState(getApiUrl());
  const [apiKey, setApiKey] = useState(getApiKey() ?? "");
  const baselineRef = useRef({ url, key: apiKey });
  const testingRef = useRef(false);
  const savingRef = useRef(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<"idle" | "ok" | "fail">("idle");
  const [testMsg, setTestMsg] = useState("");

  const testCurrentConfig = async (): Promise<boolean> => {
    if (testingRef.current) return false;
    testingRef.current = true;
    setTesting(true);
    setTestState("idle");
    try {
      const result = await validateApiConnection(url, apiKey);
      if (result.data) {
        setTestState("ok");
        const auth = result.data.authenticated ? "API key valid" : "no API key";
        setTestMsg(`OK · v${result.data.health.version} · ${auth}`);
        return true;
      }
      setTestState("fail");
      setTestMsg(result.error.message);
      return false;
    } catch (error) {
      setTestState("fail");
      setTestMsg(
        describeSettingsFailure(error, "Connection test could not complete."),
      );
      return false;
    } finally {
      testingRef.current = false;
      setTesting(false);
    }
  };

  const onSave = async (): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (!(await testCurrentConfig())) return;
      await setApiConfig(url, apiKey);
      await loadMe();
      baselineRef.current = { url, key: "" };
      setApiKey("");
      toast.success("API connection saved");
    } catch (error) {
      toast.error(
        describeSettingsFailure(
          error,
          "Could not save the API credential securely.",
        ),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const dirty =
    url !== baselineRef.current.url || apiKey !== baselineRef.current.key;
  useEffect(() => {
    if (!dirty && !testing && !saving) return;
    return registerLifecycleGuard({
      id: "settings-api-connection",
      label: "API connection changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : testing || saving
            ? {
                level: "blocking",
                detail:
                  "Moosewave is still validating or securely saving the API connection.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail:
                  "The API URL or credential has not been saved. Return to Settings or explicitly discard the local values.",
              },
      prepare: testing || saving ? undefined : onSave,
      discard: () => {
        setUrl(baselineRef.current.url);
        setApiKey(baselineRef.current.key);
        setTestState("idle");
        setTestMsg("");
      },
    });
  }, [apiKey, dirty, onSave, saving, testing, url]);

  return {
    url,
    setUrl,
    apiKey,
    setApiKey,
    testing,
    saving,
    testState,
    testMsg,
    onTest: async () => {
      await testCurrentConfig();
    },
    onSave,
  };
}

function useSensitiveSettingsActions({
  canAdmin,
  setMe,
  setPrivacyErr,
  setPrivacyRequests,
}: {
  canAdmin: boolean;
  setMe: (value: AuthMeResponse | null) => void;
  setPrivacyErr: (value: string | null) => void;
  setPrivacyRequests: (value: PrivacyRequestRecord[]) => void;
}): {
  totpModalOpen: boolean;
  setTotpModalOpen: (value: boolean) => void;
  disablingTotp: boolean;
  deletionBusy: boolean;
  exportBusy: boolean;
  pendingConfirm: PendingConfirm | null;
  setPendingConfirm: (value: PendingConfirm | null) => void;
  confirmBusy: boolean;
  setConfirmBusy: (value: boolean) => void;
  onRequestAccountDeletion: () => void;
  onRequestDataExport: () => Promise<void>;
  onReset: () => void;
  onDisableTotp: () => void;
} {
  const [totpModalOpen, setTotpModalOpen] = useState(false);
  const [disablingTotp, setDisablingTotp] = useState(false);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const exportBusyRef = useRef(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null,
  );
  const [confirmBusy, setConfirmBusy] = useState(false);

  const refreshPrivacyHistory = async (): Promise<void> => {
    try {
      const result = await listPrivacyRequests();
      if (result.data) {
        setPrivacyErr(null);
        setPrivacyRequests(
          Array.isArray(result.data.requests) ? result.data.requests : [],
        );
      } else {
        setPrivacyErr(result.error.message);
      }
    } catch (error) {
      setPrivacyErr(
        describeSettingsFailure(
          error,
          "Couldn't refresh privacy request history.",
        ),
      );
    }
  };

  const onRequestAccountDeletion = (): void => {
    if (!canAdmin) {
      toast.error({
        message: "Admin access required",
        detail: "Only workspace admins can request account deletion.",
      });
      return;
    }
    if (deletionBusy) return;
    setPendingConfirm({
      title: "Request account deletion?",
      description:
        "Opens a privacy review for this Moosewave account and its workspace data. We'll confirm by email before any irreversible step.",
      confirmLabel: "Request deletion",
      danger: true,
      typeToConfirm: "DELETE",
      run: async () => {
        setDeletionBusy(true);
        try {
          const result = await requestAccountDeletion({
            region: "OTHER",
            notes: "Requested from Moosewave Desktop settings.",
          });
          if (!result.data) {
            toast.error({
              message: "Couldn't queue deletion review",
              detail: redact(result.error.message),
            });
            return;
          }
          void refreshPrivacyHistory();
          toast.success({
            message: "Deletion review queued",
            detail: `Request ${result.data.request_id}. We'll confirm by email before any irreversible step.`,
          });
        } finally {
          setDeletionBusy(false);
        }
      },
    });
  };

  const onRequestDataExport = async (): Promise<void> => {
    if (!canAdmin) {
      toast.error({
        message: "Admin access required",
        detail: "Only workspace admins can request full data exports.",
      });
      return;
    }
    if (exportBusyRef.current) return;
    exportBusyRef.current = true;
    setExportBusy(true);
    try {
      const result = await requestDataExport({
        region: "OTHER",
        notes: "Requested from Moosewave Desktop settings.",
      });
      if (!result.data) {
        toast.error({
          message: "Couldn't queue data export",
          detail: redact(result.error.message),
        });
        return;
      }
      void refreshPrivacyHistory();
      toast.success({
        message: "Data export queued",
        detail: `Request ${result.data.request_id}. We'll email a download link when it's ready.`,
      });
    } catch (error) {
      toast.error({
        message: "Couldn't queue data export",
        detail: redact(
          describeSettingsFailure(error, "The export service is unavailable."),
        ),
      });
    } finally {
      exportBusyRef.current = false;
      setExportBusy(false);
    }
  };

  const onReset = (): void => {
    setPendingConfirm({
      title: "Sign out and reset API connection?",
      description:
        "Signs you out and clears the API URL + key from this device. Other devices remain signed in.",
      confirmLabel: "Sign out",
      danger: true,
      run: async () => {
        const result = await requestFullSignOut();
        if (result === "proceeded") window.location.reload();
      },
    });
  };

  const onDisableTotp = (): void => {
    setPendingConfirm({
      title: "Disable 2-step verification?",
      description:
        "Your account will be protected only by your password. You can re-enable 2FA any time.",
      confirmLabel: "Disable 2FA",
      danger: true,
      run: async () => {
        setDisablingTotp(true);
        try {
          const result = await apiAuth.totpDisable();
          if (result.error) {
            toast.error({
              message: "Couldn't disable 2-step verification",
              detail: redact(result.error.message),
            });
            return;
          }
          toast.success("2-step verification disabled");
          const identity = await apiAuth.getAuthMe();
          if (identity.data) {
            setMe(identity.data);
            rememberSession(identity.data);
          }
        } finally {
          setDisablingTotp(false);
        }
      },
    });
  };

  return {
    totpModalOpen,
    setTotpModalOpen,
    disablingTotp,
    deletionBusy,
    exportBusy,
    pendingConfirm,
    setPendingConfirm,
    confirmBusy,
    setConfirmBusy,
    onRequestAccountDeletion,
    onRequestDataExport,
    onReset,
    onDisableTotp,
  };
}

export function Settings(): ReactElement {
  const desktopRoute = useDesktopRoute();
  const themePreference = useThemePreference();
  const canAdmin = useCanAdmin();
  const connection = useApiConnectionSettings();
  const bootstrap = useSettingsBootstrap();
  const sensitive = useSensitiveSettingsActions({
    canAdmin,
    setMe: bootstrap.setMe,
    setPrivacyErr: bootstrap.setPrivacyErr,
    setPrivacyRequests: bootstrap.setPrivacyRequests,
  });
  const [tourOpen, setTourOpen] = useState<boolean>(false);
  const tourCtl = useTour();
  const telemetry = useTelemetryConsentSetting();
  const nativeKeyStored = tauriApi.apiBrokerStatus().configured;
  useSettingsAnchorFocus(desktopRoute);

  const setupSteps = buildSettingsSetupSteps({
    themePreference,
    apiKey: connection.apiKey,
    email: bootstrap.me?.email,
    totpEnabled: bootstrap.me?.totp_enabled,
  });

  return (
    <>
      <SettingsPrimarySections
        canAdmin={canAdmin}
        setupSteps={setupSteps}
        url={connection.url}
        apiKey={connection.apiKey}
        nativeKeyStored={nativeKeyStored}
        testing={connection.testing}
        saving={connection.saving}
        testState={connection.testState}
        testMsg={connection.testMsg}
        onUrlChange={connection.setUrl}
        onKeyChange={connection.setApiKey}
        onTest={connection.onTest}
        onSave={connection.onSave}
        onOpenTour={() => setTourOpen(true)}
        onReplayTour={tourCtl.replay}
        onFullWalkthrough={tourCtl.fullWalkthrough}
      />
      <SettingsPrivacySections
        canAdmin={canAdmin}
        telemetryOptOut={telemetry.optOut}
        telemetryBusy={telemetry.busy}
        telemetryError={telemetry.error}
        deletionBusy={sensitive.deletionBusy}
        exportBusy={sensitive.exportBusy}
        privacyLoaded={bootstrap.privacyLoaded}
        privacyErr={bootstrap.privacyErr}
        privacyRequests={bootstrap.privacyRequests}
        version={bootstrap.version}
        onTelemetryChange={telemetry.change}
        onRequestAccountDeletion={sensitive.onRequestAccountDeletion}
        onRequestDataExport={sensitive.onRequestDataExport}
      />
      <SettingsSecuritySections
        me={bootstrap.me}
        identityLoaded={bootstrap.identityLoaded}
        identityErr={bootstrap.identityErr}
        disablingTotp={sensitive.disablingTotp}
        onDisableTotp={sensitive.onDisableTotp}
        onOpenTotp={() => sensitive.setTotpModalOpen(true)}
        onReset={sensitive.onReset}
      />
      <SettingsOverlays
        me={bootstrap.me}
        setMe={bootstrap.setMe}
        totpModalOpen={sensitive.totpModalOpen}
        setTotpModalOpen={sensitive.setTotpModalOpen}
        tourOpen={tourOpen}
        setTourOpen={setTourOpen}
        pendingConfirm={sensitive.pendingConfirm}
        setPendingConfirm={sensitive.setPendingConfirm}
        confirmBusy={sensitive.confirmBusy}
        setConfirmBusy={sensitive.setConfirmBusy}
      />
    </>
  );
}

function useTelemetryConsentSetting(): {
  optOut: boolean;
  busy: boolean;
  error: string | null;
  change: (optOut: boolean) => void;
} {
  const [optOut, setOptOut] = useState(getTelemetryOptOut);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const change = (nextOptOut: boolean): void => {
    if (requestRef.current) return;
    setBusy(true);
    setError(null);
    const request = setTelemetryOptOut(nextOptOut)
      .then(() => {
        if (!mountedRef.current) return;
        const persisted = getTelemetryOptOut();
        setOptOut(persisted);
        if (persisted !== nextOptOut) {
          setError(
            "The preference could not be stored. Usage data remains disabled.",
          );
        }
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setOptOut(getTelemetryOptOut());
        setError(
          "The preference could not be applied. No usage data was sent.",
        );
      })
      .finally(() => {
        if (requestRef.current === request) requestRef.current = null;
        if (mountedRef.current) setBusy(false);
      });
    requestRef.current = request;
  };
  return { optOut, busy, error, change };
}

interface SettingsPrimarySectionsProps {
  canAdmin: boolean;
  setupSteps: SettingsSetupStep[];
  url: string;
  apiKey: string;
  nativeKeyStored: boolean;
  testing: boolean;
  saving: boolean;
  testState: "idle" | "ok" | "fail";
  testMsg: string;
  onUrlChange: (value: string) => void;
  onKeyChange: (value: string) => void;
  onTest: () => Promise<void>;
  onSave: () => Promise<void>;
  onOpenTour: () => void;
  onReplayTour: () => void;
  onFullWalkthrough: () => void;
}

function SettingsPrimarySections({
  canAdmin,
  setupSteps,
  url,
  apiKey,
  nativeKeyStored,
  testing,
  saving,
  testState,
  testMsg,
  onUrlChange,
  onKeyChange,
  onTest,
  onSave,
  onOpenTour,
  onReplayTour,
  onFullWalkthrough,
}: SettingsPrimarySectionsProps): ReactElement {
  const connectionBusy = testing || saving;
  const connectionStatusId = useId();
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-subtitle">
            App preferences and workspace config
          </div>
        </div>
      </div>
      <SettingsNavigator />
      <ProductWalkthroughsSection
        onOpenTour={onOpenTour}
        onReplayTour={onReplayTour}
        onFullWalkthrough={onFullWalkthrough}
      />
      <SettingsSetupProgress steps={setupSteps} />
      <DesktopUpdateSettings />
      <DesktopWindowSettings />
      <KeyboardShortcutsSection />
      <WorkspaceProfileSection />
      <NotificationsSection />
      <RetentionSection />
      <RolesSection />

      <div className="settings-section" data-tour="settings-domain-section">
        <div className="settings-section-head">
          <h2 className="settings-section-title">API connection</h2>
          <div className="settings-section-sub">
            Where the desktop app sends its requests.
          </div>
        </div>
        <div className="settings-section-body">
          <div className="field">
            <label
              className="label"
              htmlFor="set-url"
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              API URL
              <InlineHelp text="Base URL of the Moosewave gateway this desktop app talks to. Use the default unless self-hosting." />
            </label>
            <input
              id="set-url"
              className="input mono"
              value={url}
              onChange={(event) => onUrlChange(event.target.value)}
              placeholder={DEFAULT_API_URL}
              disabled={connectionBusy}
            />
          </div>
          <div className="field">
            <label
              className="label"
              htmlFor="set-key"
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              API key
              <InlineHelp text="Workspace bearer token (pw_…). Generated by an admin under Workspace → API keys. Never share." />
            </label>
            <input
              id="set-key"
              className="input mono"
              type="password"
              value={apiKey}
              onChange={(event) => onKeyChange(event.target.value)}
              placeholder={
                nativeKeyStored ? "Stored securely — enter to replace" : "pw_…"
              }
              autoComplete="off"
              spellCheck={false}
              disabled={connectionBusy}
            />
            <div className="field-help">
              {nativeKeyStored
                ? "Stored by the native broker and never returned to this page."
                : "Sent as Authorization: Bearer pw_…"}
            </div>
          </div>
          <div className="settings-row">
            <div
              id={connectionStatusId}
              className="row"
              role="status"
              aria-live="polite"
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    testState === "ok"
                      ? "var(--pw-success)"
                      : testState === "fail"
                        ? "var(--pw-danger)"
                        : "var(--pw-fg-subtle)",
                }}
              />
              <span className="muted">
                {testing
                  ? "Testing…"
                  : testState === "ok"
                    ? testMsg
                    : testState === "fail"
                      ? `Failed: ${testMsg}`
                      : "Not tested"}
              </span>
            </div>
            <div className="row">
              <button
                type="button"
                className="btn"
                onClick={() => void onTest()}
                disabled={connectionBusy}
                aria-describedby={
                  connectionBusy ? connectionStatusId : undefined
                }
              >
                Test connection
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void onSave()}
                disabled={connectionBusy}
                aria-describedby={
                  connectionBusy ? connectionStatusId : undefined
                }
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <ApiKeysSection />
      <InactiveKeysCard />
      <PlanSummaryCard />
      <UsageSection />
      <CustomFieldGovernance />
      <IdentifierTransformsSection />
      <DataPrivacySection />
      <div
        className="settings-section"
        data-settings-anchor="ai-brand-voice-gate"
      >
        <div className="settings-section-head">
          <h2 className="settings-section-title">AI brand-voice gate</h2>
          <div className="settings-section-sub">
            Review golden references and configure recorded policy evaluations.
            Deployment enforcement is not connected to these outcomes.
          </div>
        </div>
        <div className="settings-section-body">
          <AIRegressionSettings canAdmin={canAdmin} />
        </div>
      </div>
      <AppearanceSettings />
    </>
  );
}

interface SettingsPrivacySectionsProps {
  canAdmin: boolean;
  telemetryOptOut: boolean;
  telemetryBusy: boolean;
  telemetryError: string | null;
  deletionBusy: boolean;
  exportBusy: boolean;
  privacyLoaded: boolean;
  privacyErr: string | null;
  privacyRequests: PrivacyRequestRecord[];
  version: string;
  onTelemetryChange: (optOut: boolean) => void;
  onRequestAccountDeletion: () => void;
  onRequestDataExport: () => Promise<void>;
}

function SettingsPrivacySections({
  canAdmin,
  telemetryOptOut,
  telemetryBusy,
  telemetryError,
  deletionBusy,
  exportBusy,
  privacyLoaded,
  privacyErr,
  privacyRequests,
  version,
  onTelemetryChange,
  onRequestAccountDeletion,
  onRequestDataExport,
}: SettingsPrivacySectionsProps): ReactElement {
  const deletionReasonId = useId();
  const exportReasonId = useId();
  const telemetryHelpId = useId();
  const telemetryErrorId = useId();
  return (
    <>
      <div className="settings-section">
        <div className="settings-section-head">
          <h2 className="settings-section-title">Privacy</h2>
          <div className="settings-section-sub">
            Pseudonymous usage data helps us prioritise features. Subscriber
            data, email content, names, and raw account identifiers are never
            sent.
          </div>
        </div>
        <div className="settings-section-body">
          <div className="settings-row">
            <div>
              <div
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                Send pseudonymous usage data to help improve Moosewave
                <InlineHelp text="Sends reviewed events, counts, durations, and structural error codes only. A one-way local fingerprint keeps sessions distinct without sending raw user or workspace identifiers." />
              </div>
              <div
                id={telemetryHelpId}
                className="muted"
                style={{ fontSize: 12 }}
              >
                Reviewed events, counts, durations, and structural error codes
                only. Changes apply immediately; no restart is needed.
              </div>
              {telemetryError ? (
                <div id={telemetryErrorId} className="field-error" role="alert">
                  {telemetryError}
                </div>
              ) : null}
            </div>
            <label className="radio-row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={!telemetryOptOut}
                disabled={telemetryBusy}
                aria-label="Send pseudonymous usage data"
                aria-describedby={`${telemetryHelpId}${telemetryError ? ` ${telemetryErrorId}` : ""}`}
                onChange={(event) => onTelemetryChange(!event.target.checked)}
              />
              {telemetryBusy
                ? "Saving…"
                : telemetryOptOut
                  ? "Disabled"
                  : "Enabled"}
            </label>
          </div>
          <div className="settings-row">
            <div>
              <div
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                Account deletion
                <InlineHelp text="Type-to-confirm; queues a 30-day privacy review. Cancellable until the review closes. Removes you and any sole-owner workspaces." />
              </div>
              <div
                id={deletionReasonId}
                className="muted"
                style={{ fontSize: 12 }}
              >
                {!canAdmin
                  ? "Only workspace admins can request account deletion."
                  : deletionBusy
                    ? "A deletion request is being queued. Wait for it to finish before requesting another."
                    : "Queue a verified deletion review for your account and related workspace data. We confirm completion by email."}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-danger"
              onClick={onRequestAccountDeletion}
              disabled={deletionBusy || !canAdmin}
              aria-describedby={deletionReasonId}
            >
              {deletionBusy ? "Requesting…" : "Request deletion"}
            </button>
          </div>
          <div className="settings-row">
            <div>
              <div
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                Data export
                <InlineHelp text="Builds a portable JSON + CSV bundle of your workspace data. We email a one-time download link when ready (usually 1–10 min)." />
              </div>
              <div
                id={exportReasonId}
                className="muted"
                style={{ fontSize: 12 }}
              >
                {!canAdmin
                  ? "Only workspace admins can request a full workspace data export."
                  : exportBusy
                    ? "A data export request is being queued. Wait for it to finish before requesting another."
                    : "Queue a portable workspace export and track it in request history."}
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => void onRequestDataExport()}
              disabled={exportBusy || !canAdmin}
              aria-describedby={exportReasonId}
            >
              {exportBusy ? "Requesting…" : "Request export"}
            </button>
          </div>
          <div className="settings-row" style={{ alignItems: "flex-start" }}>
            <div>
              <div>Privacy request history</div>
              <div className="muted" style={{ fontSize: 12 }}>
                Latest export, deletion, correction, and opt-out requests.
              </div>
            </div>
            <div
              role="status"
              aria-live="polite"
              style={{ minWidth: 260, textAlign: "right" }}
            >
              {!privacyLoaded ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  Loading request history…
                </span>
              ) : privacyErr ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  Couldn&apos;t load history — {privacyErr}
                </span>
              ) : privacyRequests.length === 0 ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  No requests yet
                </span>
              ) : (
                <div style={{ display: "grid", gap: 6 }}>
                  {privacyRequests.slice(0, 3).map((request) => (
                    <div
                      key={request.request_id}
                      className="muted"
                      style={{ fontSize: 12 }}
                    >
                      <strong>{request.type.replaceAll("_", " ")}</strong> ·{" "}
                      {request.status.replaceAll("_", " ")} · due{" "}
                      {new Date(request.due_at).toLocaleDateString()}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <ExportRetentionSection canAdmin={canAdmin} />
      <DataExportsSection />
      <DigestPrefsSection />
      <AlertPrefsSection />
      <div className="settings-section">
        <div className="settings-section-head">
          <h2 className="settings-section-title">About</h2>
          <div className="settings-section-sub">Version and resources</div>
        </div>
        <div className="settings-section-body">
          <div className="settings-row">
            <div>App version</div>
            <span className="mono muted">{version}</span>
          </div>
          <div className="settings-row">
            <div>Source</div>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() =>
                void tauriApi.openUrl("https://github.com/postwave/postwave")
              }
            >
              github.com/postwave/postwave
            </button>
          </div>
          <div className="settings-row">
            <div>Legal</div>
            <LegalLinks
              align="right"
              links={[
                { key: "privacy", label: "Privacy" },
                { key: "terms", label: "Terms" },
                { key: "accountDeletion", label: "Account deletion" },
                { key: "support", label: "Support" },
              ]}
            />
          </div>
          <div className="settings-row">
            <div>Privacy contact</div>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() =>
                void tauriApi.openUrl("mailto:privacy@moosewave.com")
              }
            >
              privacy@moosewave.com
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

interface ProductWalkthroughsSectionProps {
  onOpenTour: () => void;
  onReplayTour: () => void;
  onFullWalkthrough: () => void;
}

function ProductWalkthroughsSection({
  onOpenTour,
  onReplayTour,
  onFullWalkthrough,
}: ProductWalkthroughsSectionProps): ReactElement {
  return (
    <div className="settings-section" data-settings-anchor="tour">
      <div className="settings-section-head">
        <h2 className="settings-section-title">Tour</h2>
        <div className="settings-section-sub">
          Product walkthroughs for the whole workspace, a quick refresher, or
          one area at a time.
        </div>
      </div>
      <div className="settings-section-body">
        <div className="settings-row">
          <div>
            <div>Full workspace walkthrough</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Visits every tab in sidebar order, opens the real page, and
              explains the options you&apos;ll use there. The tour never changes
              workspace data.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onFullWalkthrough}
          >
            Start full walkthrough
          </button>
        </div>
        <div className="settings-row">
          <div>
            <div>Quick product tour</div>
            <div className="muted" style={{ fontSize: 12 }}>
              A short pass through the dashboard, campaigns, audience,
              sequences, and sending setup.
            </div>
          </div>
          <button type="button" className="btn" onClick={onReplayTour}>
            Start quick tour
          </button>
        </div>
        <div className="settings-row">
          <div>
            <div>Explore by area</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Pick a single area when you already know what you want to see.
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onOpenTour}>
            Choose an area
          </button>
        </div>
      </div>
    </div>
  );
}

interface SettingsSecuritySectionsProps {
  me: AuthMeResponse | null;
  identityLoaded: boolean;
  identityErr: string | null;
  disablingTotp: boolean;
  onDisableTotp: () => void;
  onOpenTotp: () => void;
  onReset: () => void;
}

function SettingsSecuritySections({
  me,
  identityLoaded,
  identityErr,
  disablingTotp,
  onDisableTotp,
  onOpenTotp,
  onReset,
}: SettingsSecuritySectionsProps): ReactElement {
  const twoStepDescriptionId = useId();
  return (
    <>
      <div className="settings-section">
        <div className="settings-section-head">
          <h2 className="settings-section-title">Security</h2>
          <div className="settings-section-sub">
            Two-step verification protects your account when your password is
            compromised.
          </div>
        </div>
        <div className="settings-section-body" aria-live="polite">
          {!identityLoaded ? (
            <div className="settings-row">
              <span className="muted">Loading account security…</span>
            </div>
          ) : identityErr ? (
            <div className="settings-row">
              <span className="muted">
                Couldn&apos;t load account security — {identityErr}
              </span>
            </div>
          ) : me ? (
            <>
              <div className="settings-row">
                <div>
                  <div>Signed in as</div>
                  <div className="muted mono" style={{ fontSize: 12 }}>
                    {me.email} · {me.workspace_slug || me.tenant_id}
                  </div>
                </div>
                <span className="badge">{me.auth_provider}</span>
              </div>
              <div className="settings-row">
                <div>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <span>2-step verification</span>
                    <span
                      className={`badge ${me.totp_enabled ? "success" : "warning"}`}
                    >
                      {me.totp_enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <div
                    id={twoStepDescriptionId}
                    className="muted"
                    style={{ fontSize: 12 }}
                  >
                    Use an authenticator app (Authy, 1Password, Google
                    Authenticator) to generate sign-in codes.
                    {disablingTotp
                      ? " 2-step verification is currently being disabled."
                      : ""}
                  </div>
                </div>
                {me.totp_enabled ? (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={onDisableTotp}
                    disabled={disablingTotp}
                    aria-describedby={twoStepDescriptionId}
                  >
                    {disablingTotp
                      ? "Disabling…"
                      : "Disable 2-step verification"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={onOpenTotp}
                  >
                    Set up 2-step verification
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="settings-row">
              <span className="muted">
                No authenticated account is available.
              </span>
            </div>
          )}
        </div>
      </div>

      <AccountSecuritySection />
      <DeviceApprovalSection me={me} />
      <FirewallSection />
      <FeatureFlagsSection />
      <RegionSection />
      <ApprovalChainSection />
      <ArchiveDomainSection />

      <div className="settings-section">
        <div className="settings-section-head">
          <h2 className="settings-section-title">Workspace</h2>
          <div className="settings-section-sub">
            Sign out and reset local state
          </div>
        </div>
        <div className="settings-section-body">
          <div className="settings-row">
            <div className="muted" style={{ fontSize: 12 }}>
              Clears your API URL and key from this device.
            </div>
            <button type="button" className="btn btn-danger" onClick={onReset}>
              Sign out / Reset
            </button>
          </div>
        </div>
      </div>
      <SlackIntegrationSection />
      <WebhookAdministrationSummary />
      <SampleDataSection />
    </>
  );
}

interface SettingsOverlaysProps {
  me: AuthMeResponse | null;
  setMe: (value: AuthMeResponse | null) => void;
  totpModalOpen: boolean;
  setTotpModalOpen: (value: boolean) => void;
  tourOpen: boolean;
  setTourOpen: (value: boolean) => void;
  pendingConfirm: PendingConfirm | null;
  setPendingConfirm: (value: PendingConfirm | null) => void;
  confirmBusy: boolean;
  setConfirmBusy: (value: boolean) => void;
}

function SettingsOverlays({
  setMe,
  totpModalOpen,
  setTotpModalOpen,
  tourOpen,
  setTourOpen,
  pendingConfirm,
  setPendingConfirm,
  confirmBusy,
  setConfirmBusy,
}: SettingsOverlaysProps): ReactElement {
  const confirmBusyRef = useRef(false);
  const onEnrolled = async (): Promise<void> => {
    toast.success("2-step verification enabled");
    try {
      const response = await apiAuth.getAuthMe();
      if (response.data) {
        setMe(response.data);
        rememberSession(response.data);
      } else {
        toast.error(
          "2-step verification changed, but account status could not refresh.",
        );
      }
    } catch (error) {
      toast.error(
        describeSettingsFailure(
          error,
          "Account security status could not refresh.",
        ),
      );
    }
  };

  const onConfirm = async (): Promise<void> => {
    if (!pendingConfirm || confirmBusyRef.current) return;
    confirmBusyRef.current = true;
    setConfirmBusy(true);
    try {
      await pendingConfirm.run();
      setPendingConfirm(null);
    } catch (error) {
      toast.error(
        describeSettingsFailure(error, "The requested action failed."),
      );
    } finally {
      confirmBusyRef.current = false;
      setConfirmBusy(false);
    }
  };

  return (
    <>
      <TotpSetupModal
        open={totpModalOpen}
        onClose={() => setTotpModalOpen(false)}
        onEnrolled={() => void onEnrolled()}
      />
      {tourOpen ? (
        <Suspense fallback={null}>
          <OnboardingTour onClose={() => setTourOpen(false)} />
        </Suspense>
      ) : null}
      <ConfirmModal
        key={pendingConfirm?.title ?? "idle"}
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? ""}
        description={pendingConfirm?.description}
        confirmLabel={pendingConfirm?.confirmLabel ?? "Confirm"}
        danger={pendingConfirm?.danger}
        typeToConfirm={pendingConfirm?.typeToConfirm}
        busy={confirmBusy}
        onClose={() => (confirmBusy ? undefined : setPendingConfirm(null))}
        onConfirm={() => void onConfirm()}
      />
    </>
  );
}

/**
 * SlackIntegrationSection — wired to the Slack approval-bot OAuth
 * flow. Shows connection status (workspace name + default channel)
 * when present; otherwise renders a "Connect Slack" CTA that hands
 * the user off to the gateway's /api/v1/slack/oauth/start endpoint.
 *
 * Append-only addition; lives in its own component so the existing
 * Settings function stays untouched.
 */
function SlackIntegrationSection(): ReactElement {
  const gateReasonId = useId();
  const [conn, setConn] = useState<SlackConnection | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // D14-settings-misc#6: distinguish a genuine 404 (no connection wired
  // → "Not connected") from a 500/network outage. The latter used to
  // render as "Not connected", inviting the operator to re-run OAuth
  // against a live connection.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  // Confirm before disconnecting — pre-fix Disconnect was a single
  // click with no recovery path, which had bitten an operator on a
  // call who clicked through muscle memory and lost their bot config.
  const [showDisconnect, setShowDisconnect] = useState<boolean>(false);
  // Availability probe — is Slack OAuth possible on this deployment +
  // session at all? `configured: false` means the server has no Slack
  // credentials; `requires_session` tells us whether the OAuth start
  // route needs a cookie session. Null = probe failed (network, older
  // server) → deriveSlackGate falls back to the conservative
  // session-only gate below.
  const [availability, setAvailability] = useState<SlackAvailability | null>(
    null,
  );
  // The OAuth start route is cookie-session authenticated only (see
  // slackOAuthStartUrl in api-client.ts — stream tokens are rejected),
  // so API-key-only sessions can't start the flow. Gate the CTA.
  const sessionAuth = hasRememberedSession();
  const gate = deriveSlackGate(availability, sessionAuth);

  const [reloadTick, setReloadTick] = useState<number>(0);
  useEffect(() => {
    let mounted = true;
    void (async () => {
      setLoading(true);
      setLoadErr(null);
      const [res, avail] = await Promise.all([
        getSlackConnection(),
        getSlackAvailability(),
      ]);
      if (!mounted) return;
      if (res.data) {
        setConn(res.data);
      } else if (res.error && res.error.status !== 404) {
        // A real outage — don't fabricate "Not connected".
        setLoadErr(res.error.message ?? "Couldn't load Slack connection.");
      } else {
        // 404 / no connection wired; treat as disconnected.
        setConn({ connected: false });
      }
      // Availability errors leave the state null → conservative gate.
      if (avail.data) setAvailability(avail.data);
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [reloadTick]);

  const onConnect = (): void => {
    // Hand off to the gateway, which will 302 to Slack with a signed
    // state token. The browser keeps the session cookie so the start
    // endpoint's auth gate is satisfied.
    const target = safeSlackOAuthStartUrl(slackOAuthStartUrl());
    if (!target) {
      toast.error({
        message: "Couldn't open Slack connect",
        detail: "The OAuth URL failed safety checks.",
      });
      return;
    }
    window.location.assign(target);
  };

  const onDisconnect = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const res = await disconnectSlack();
    setBusy(false);
    if (res.data) {
      setConn({ connected: false });
      toast.success("Slack workspace disconnected");
    } else {
      toast.error({
        message: "Couldn't disconnect Slack",
        detail: res.error.message,
      });
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">Slack</h2>
        <div className="settings-section-sub">
          Approve campaign sends from Slack and run /postwave commands from any
          channel the bot is in.
        </div>
      </div>
      <div className="settings-section-body">
        {loading ? (
          <div className="settings-row">
            <div className="muted" style={{ fontSize: 12 }}>
              Loading…
            </div>
          </div>
        ) : loadErr ? (
          <div className="settings-row">
            <div className="muted" style={{ fontSize: 12 }}>
              Couldn&apos;t load Slack connection: {loadErr}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ marginLeft: 8 }}
                onClick={() => setReloadTick((t) => t + 1)}
              >
                Retry
              </button>
            </div>
          </div>
        ) : conn?.connected ? (
          <div className="settings-row">
            <div>
              <div>
                Connected to <strong>{conn.team_name || conn.team_id}</strong>
              </div>
              <div className="muted mono" style={{ fontSize: 12 }}>
                Default channel:{" "}
                {conn.default_channel_name
                  ? `#${conn.default_channel_name}`
                  : conn.default_channel_id || "(not set)"}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setShowDisconnect(true)}
              disabled={busy}
            >
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <div className="settings-row">
            <div id={gateReasonId} className="muted" style={{ fontSize: 12 }}>
              Not connected. Approval messages and /postwave commands will be
              unavailable until you connect a Slack workspace.
              {gate.kind === "not_configured" ? (
                <div style={{ marginTop: 4 }}>
                  Slack integration isn&apos;t configured on this server.
                </div>
              ) : gate.kind === "needs_session" ? (
                <div style={{ marginTop: 4 }}>
                  Sign in with your Moosewave account (not an API key) to connect
                  Slack.
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="btn"
              onClick={onConnect}
              disabled={gate.kind !== "ok"}
              aria-describedby={gate.kind !== "ok" ? gateReasonId : undefined}
            >
              Connect Slack
            </button>
          </div>
        )}
      </div>

      <ConfirmModal
        open={showDisconnect}
        title="Disconnect Slack workspace?"
        description="Approval messages and /postwave commands will stop working until you reconnect. Your Slack configuration in Moosewave is forgotten."
        confirmLabel="Disconnect"
        danger
        busy={busy}
        onClose={() => setShowDisconnect(false)}
        onConfirm={async () => {
          await onDisconnect();
          setShowDisconnect(false);
        }}
      />
    </div>
  );
}

/**
 * SampleDataSection — admin-only "Load sample data" pane in Settings.
 * Calls the gateway's seed/remove endpoints. Idempotent on the
 * server: re-running Load is a no-op once the tenant is already
 * seeded (the button stays disabled in that state). Remove deletes
 * exactly the rows the seeder inserted (sentinel marker).
 *
 * Visibility: hidden for non-admin roles (the API enforces the same
 * gate, so a viewer hitting the endpoint directly gets 403 too).
 *
 * Status: GET /api/v1/onboarding/sample-data is the source of truth
 * (seeded / seeded_at / counts). When the probe fails we render an
 * honest "Unknown" badge with the error — never a fabricated "Empty".
 * Re-probed after every successful seed/remove.
 */
function SampleDataSection(): ReactElement | null {
  // NOTE: showRemove must live at the top alongside the other useState
  // hooks (rules-of-hooks). Pre-fix it was declared mid-function after
  // a const arrow, which lint correctly flagged as conditional-hook.
  const canAdmin = useCanAdmin();
  const actionHintId = useId();
  const [status, setStatus] = useState<SampleDataStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [showRemove, setShowRemove] = useState<boolean>(false);

  const refreshStatus = async (): Promise<void> => {
    setStatusLoading(true);
    setStatusErr(null);
    const res = await getSampleDataStatus();
    if (res.error) {
      // Honest failure: keep the badge at "Unknown" and surface why,
      // instead of guessing from device-local breadcrumbs.
      setStatusErr(res.error.message);
      setStatus(null);
    } else {
      setStatus(res.data);
    }
    setStatusLoading(false);
  };

  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const badge = deriveSampleBadge(statusLoading, statusErr, status);
  // true = seeded, false = empty, null = unknown / still checking.
  const seeded: boolean | null =
    badge === "seeded" ? true : badge === "empty" ? false : null;
  const countsLine = formatSampleCounts(status?.counts);

  if (!canAdmin) return null;

  const onLoad = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setStatusMsg("");
    const res = await seedSampleDataStrict();
    setBusy(false);
    if (res.error) {
      toast.error({
        message: "Couldn't load sample data",
        detail: res.error.message,
      });
      setStatusMsg(`Failed: ${res.error.message}`);
      return;
    }
    const c = res.data.counts;
    const summary = `${c.subscribers} ${c.subscribers === 1 ? "subscriber" : "subscribers"}, ${c.campaigns} ${c.campaigns === 1 ? "campaign" : "campaigns"}, ${c.segments} ${c.segments === 1 ? "segment" : "segments"}, ${c.sequences} ${c.sequences === 1 ? "sequence" : "sequences"}`;
    toast.success({
      message: "Sample data loaded",
      detail: summary,
    });
    setStatusMsg(res.data.note || `Loaded ${summary}`);
    // Re-probe so the badge / seeded_at / counts reflect server truth
    // (the seed response's counts can lag what the seeder net-inserted
    // on an already-seeded tenant).
    await refreshStatus();
  };

  /**
   * Actual removal — wired to the ConfirmModal's `run` so the
   * destructive operation only fires after explicit confirmation.
   * Separated from the confirm-opener so the modal can show the
   * "Working…" state via its own busy prop while we wait.
   */
  const doRemove = async (): Promise<void> => {
    setBusy(true);
    setStatusMsg("");
    const res = await removeSampleData();
    setBusy(false);
    if (res.error) {
      toast.error({
        message: "Couldn't remove sample data",
        detail: res.error.message,
      });
      setStatusMsg(`Failed: ${res.error.message}`);
      return;
    }
    const c = res.data.counts;
    toast.success({
      message: "Sample data removed",
      detail: `${c.subscribers} ${c.subscribers === 1 ? "subscriber" : "subscribers"} and ${c.campaigns} ${c.campaigns === 1 ? "campaign" : "campaigns"} cleared.`,
    });
    setStatusMsg(
      `Removed ${c.subscribers} ${c.subscribers === 1 ? "subscriber" : "subscribers"}, ${c.campaigns} ${c.campaigns === 1 ? "campaign" : "campaigns"}, ${c.segments} ${c.segments === 1 ? "segment" : "segments"}, ${c.sequences} ${c.sequences === 1 ? "sequence" : "sequences"}`,
    );
    await refreshStatus();
  };
  const onRemove = (): void => {
    if (busy) return;
    setShowRemove(true);
  };

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">Sample data</h2>
        <div className="settings-section-sub">
          Populate this workspace with a small demo dataset (50 subscribers, one
          segment, three campaigns, one sequence) so the UI has something
          realistic to render. Safe to remove later — the seeder tags everything
          it inserts.
        </div>
      </div>
      <div className="settings-section-body">
        <div className="settings-row">
          <div className="row" style={{ alignItems: "center", gap: 8 }}>
            <span
              className={`badge${seeded ? " accent" : ""}`}
              aria-label={
                badge === "checking"
                  ? "Checking sample-data status"
                  : badge === "unknown"
                    ? "Sample-data status unknown"
                    : badge === "seeded"
                      ? "Sample data seeded"
                      : "No sample data"
              }
              title={
                badge === "seeded" && status?.seeded_at
                  ? `Seeded ${new Date(status.seeded_at).toLocaleString()}`
                  : undefined
              }
            >
              {badge === "checking"
                ? "Checking…"
                : badge === "unknown"
                  ? "Unknown"
                  : badge === "seeded"
                    ? "Seeded"
                    : "Empty"}
            </span>
            {statusMsg ? (
              <span className="muted" style={{ fontSize: 12 }}>
                {statusMsg}
              </span>
            ) : statusErr ? (
              <span className="muted" style={{ fontSize: 12 }}>
                Couldn&apos;t read sample-data status: {statusErr}{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => void refreshStatus()}
                  disabled={statusLoading}
                >
                  Retry
                </button>
              </span>
            ) : badge === "seeded" && status?.seeded_at ? (
              <span className="muted" style={{ fontSize: 12 }}>
                Seeded {new Date(status.seeded_at).toLocaleString()}
              </span>
            ) : null}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void onLoad()}
              disabled={busy || seeded === true}
              aria-describedby={actionHintId}
            >
              {busy ? "Working…" : "Load sample data"}
            </button>
            {/* Remove is offered for seeded-or-unknown: the server-side
                delete is a safe no-op when nothing was seeded. */}
            {seeded !== false ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void onRemove()}
                disabled={busy}
              >
                {busy ? "Working…" : "Remove sample data"}
              </button>
            ) : null}
          </div>
        </div>
        <div
          id={actionHintId}
          className="muted"
          role="status"
          aria-live="polite"
          style={{ fontSize: 11, marginTop: 6 }}
        >
          {busy
            ? "A sample-data operation is in progress."
            : seeded === true
              ? "Sample data is already loaded. Remove it before loading another set."
              : "Load sample data inserts 50 subscribers, 3 campaigns, 1 segment, and 1 sequence."}
        </div>
        {countsLine ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {countsLine}
          </div>
        ) : null}
      </div>
      <ConfirmModal
        open={showRemove}
        title="Delete sample data?"
        description="Removes every row the sample-data seeder added to this workspace. Real data is untouched. Reversible by re-seeding."
        confirmLabel="Delete sample data"
        danger
        busy={busy}
        onClose={() => setShowRemove(false)}
        onConfirm={async () => {
          await doRemove();
          setShowRemove(false);
        }}
      />
    </div>
  );
}
