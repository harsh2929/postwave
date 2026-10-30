/**
 * AccountMenu — top-right profile popover.
 *
 * The Account icon in TopBar was a no-op button until v2 (no onClick,
 * no onKey, just an aria-label). This component is the dropdown it
 * opens: identity header, theme quick-toggle, deep links to the
 * Settings sections that most operators come here to find,
 * keyboard-shortcuts trigger, help link, sign-out.
 *
 * Lives next to (and styled like) NotificationsPanel — same absolute
 * positioning, same outside-click + Esc dismissal. We deliberately
 * do NOT share the popover chrome between the two: the panels carry
 * different role semantics ("menu" vs "dialog") and the shared CSS
 * class collisions are easier to avoid by giving each its own root.
 *
 * Identity data comes from two places:
 *   - The store's `me` slice (user id + tenant id + role) — present
 *     immediately on mount because the dashboard pre-resolves it.
 *   - `apiAuth.getAuthMe()` — fetched on open for email +
 *     workspace_name + workspace_slug + totp_enabled, which the
 *     store slice doesn't carry today.
 */

import {
  type ReactElement,
  type RefObject,
  type SVGProps,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { apiAuth, type AuthMeResponse } from "../lib/api-client";
import { useDialogStack } from "../hooks/useDialogStack";
import { useMenuInteraction } from "../hooks/useMenuInteraction";
import { pushDialog, popDialog } from "../lib/dialogStack";
import { requestFullSignOut } from "../lib/auth";
import {
  navigateDesktopRoute,
  type SettingsAnchor,
} from "../lib/desktop-router";
import {
  setSection,
  setTheme,
  toggleViewerMode,
  useCanUseViewerMode,
  useMe,
  useTheme,
  useThemePreference,
  useViewerModeActive,
} from "../lib/store";
import { tauriApi } from "../lib/tauri";
import {
  checkForDesktopUpdate,
  installDesktopUpdate,
  requestDesktopUpdateRestart,
  retryDesktopUpdate,
  useDesktopUpdateState,
  type DesktopUpdateState,
  type DesktopUpdatePhase,
} from "../lib/desktop-update-service";
import { ConfirmModal } from "./ConfirmModal";
import { toast } from "./Toast";

import "../styles-account-menu.css";

interface Props {
  trigger: HTMLElement | null;
  open: boolean;
  onClose: () => void;
}

interface AccountIdentityHeaderProps {
  email: string;
  role: string;
  workspaceName: string;
  workspaceSlug: string;
}

function AccountIdentityHeader({
  email,
  role,
  workspaceName,
  workspaceSlug,
}: AccountIdentityHeaderProps): ReactElement {
  return (
    <div className="account-menu-header" aria-hidden="true">
      <div className="account-menu-avatar" aria-hidden="true">
        {computeInitials(email, workspaceName)}
      </div>
      <div className="account-menu-header-text">
        <div className="account-menu-email" title={email}>
          {email || <span className="muted">Loading…</span>}
        </div>
        <div className="account-menu-role-row">
          {role ? (
            <span className="badge accent account-menu-role">{role}</span>
          ) : null}
          {workspaceName ? (
            <span
              className="muted account-menu-workspace"
              title={workspaceSlug || workspaceName}
            >
              {workspaceName}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AccountMenuFooter({ version }: { version: string }): ReactElement {
  return (
    <div className="account-menu-footer" aria-hidden="true">
      <span className="muted">Moosewave Desktop</span>
      {version ? (
        <span className="mono account-menu-version">v{version}</span>
      ) : null}
    </div>
  );
}

interface AccountMenuContentProps {
  canUseViewerMode: boolean;
  email: string;
  role: string;
  rootRef: RefObject<HTMLDivElement | null>;
  serverMe: AuthMeResponse | null;
  signingOut: boolean;
  theme: ReturnType<typeof useTheme>;
  themePreference: ReturnType<typeof useThemePreference>;
  update: DesktopUpdateState;
  version: string;
  viewerModeActive: boolean;
  viewerModeBusy: boolean;
  workspaceName: string;
  workspaceSlug: string;
  onDocumentation: () => void;
  onFlipTheme: () => void;
  onFlipViewerMode: () => void;
  onOpenSignOut: () => void;
  onRunUpdate: () => void;
  onSection: (section: Parameters<typeof setSection>[0]) => void;
  onSettings: (anchor: SettingsAnchor) => void;
}

function AccountMenuContent({
  canUseViewerMode,
  email,
  role,
  rootRef,
  serverMe,
  signingOut,
  theme,
  themePreference,
  update,
  version,
  viewerModeActive,
  viewerModeBusy,
  workspaceName,
  workspaceSlug,
  onDocumentation,
  onFlipTheme,
  onFlipViewerMode,
  onOpenSignOut,
  onRunUpdate,
  onSection,
  onSettings,
}: AccountMenuContentProps): ReactElement {
  const updateDetail = update.error ?? update.releaseNotes;
  const updateDetailId = updateDetail
    ? "account-menu-update-detail"
    : undefined;
  return (
    <div
      ref={rootRef}
      id="account-menu"
      className="account-menu"
      role="menu"
      aria-label={`Account menu${email ? ` for ${email}` : ""}`}
    >
      <AccountIdentityHeader
        email={email}
        role={role}
        workspaceName={workspaceName}
        workspaceSlug={workspaceSlug}
      />
      <div className="account-menu-sep" role="separator" />
      <button
        type="button"
        className="account-menu-item"
        role="menuitem"
        tabIndex={-1}
        onClick={onFlipTheme}
      >
        <ThemeIcon dark={theme === "dark"} />
        <span className="account-menu-item-label">
          {theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        </span>
        <span className="account-menu-item-tail">
          {themePreference === "system" ? (
            <span className="badge">System · {theme}</span>
          ) : (
            <kbd>{theme === "dark" ? "Light" : "Dark"}</kbd>
          )}
        </span>
      </button>
      {canUseViewerMode ? (
        <button
          type="button"
          className={`account-menu-item${viewerModeActive ? " is-active" : ""}`}
          role="menuitemcheckbox"
          tabIndex={-1}
          aria-checked={viewerModeActive}
          onClick={onFlipViewerMode}
          disabled={viewerModeBusy}
        >
          <EyeIcon />
          <span className="account-menu-item-label">
            {viewerModeActive ? "Exit viewer preview" : "Preview as viewer"}
          </span>
          <span className="account-menu-item-tail">
            {viewerModeBusy ? (
              <span className="muted">…</span>
            ) : viewerModeActive ? (
              <span className="badge accent">On</span>
            ) : null}
          </span>
        </button>
      ) : null}
      <div className="account-menu-sep" role="separator" />
      <button
        type="button"
        className="account-menu-item"
        role="menuitem"
        tabIndex={-1}
        onClick={() => onSettings("security")}
      >
        <UserIcon />
        <span className="account-menu-item-label">Account security</span>
        <span className="account-menu-item-tail muted">
          {serverMe?.totp_enabled ? "2FA on" : ""}
        </span>
      </button>
      <button
        type="button"
        className="account-menu-item"
        role="menuitem"
        tabIndex={-1}
        onClick={() => onSettings("workspace-profile")}
      >
        <GearIcon />
        <span className="account-menu-item-label">Workspace settings</span>
      </button>
      <button
        type="button"
        className="account-menu-item"
        role="menuitem"
        tabIndex={-1}
        onClick={() => onSection("apiPlayground")}
      >
        <KeyIcon />
        <span className="account-menu-item-label">
          API keys &amp; playground
        </span>
      </button>
      <div className="account-menu-sep" role="separator" />
      <button
        type="button"
        className="account-menu-item"
        role="menuitem"
        tabIndex={-1}
        onClick={onDocumentation}
      >
        <BookIcon />
        <span className="account-menu-item-label">Documentation</span>
        <ExternalIcon />
      </button>
      <button
        type="button"
        className="account-menu-item"
        role="menuitem"
        tabIndex={-1}
        onClick={() => onSettings("keyboard-shortcuts")}
      >
        <KeyboardIcon />
        <span className="account-menu-item-label">Keyboard shortcuts</span>
        <span className="account-menu-item-tail">In app</span>
      </button>
      <button
        type="button"
        className={`account-menu-item account-menu-update-item ${updateMenuClass(
          update.phase,
        )}`}
        role="menuitem"
        tabIndex={-1}
        onClick={onRunUpdate}
        disabled={
          update.phase === "checking" ||
          update.phase === "downloading" ||
          update.phase === "installing"
        }
        aria-describedby={updateDetailId}
      >
        <UpdateIcon />
        <span className="account-menu-item-copy">
          <span className="account-menu-item-label">
            {updateMenuLabel(update.phase, update.latestVersion)}
          </span>
          {updateDetail ? (
            <span id={updateDetailId} className="account-menu-item-detail">
              {updateDetail}
            </span>
          ) : null}
        </span>
        <span className="account-menu-item-tail">{updateMenuTail(update)}</span>
      </button>
      <div className="account-menu-sep" role="separator" />
      <button
        type="button"
        className="account-menu-item account-menu-item-danger"
        role="menuitem"
        tabIndex={-1}
        onClick={onOpenSignOut}
        disabled={signingOut}
      >
        <SignOutIcon />
        <span className="account-menu-item-label">
          {signingOut ? "Signing out…" : "Sign out"}
        </span>
      </button>
      <AccountMenuFooter version={version} />
    </div>
  );
}

export function AccountMenu({
  trigger,
  open,
  onClose,
}: Props): ReactElement | null {
  const theme = useTheme();
  const themePreference = useThemePreference();
  const me = useMe();
  const [serverMe, setServerMe] = useState<AuthMeResponse | null>(null);
  const [version, setVersion] = useState<string>("");
  const [signingOut, setSigningOut] = useState(false);
  const [confirmSignOutOpen, setConfirmSignOutOpen] = useState(false);
  const update = useDesktopUpdateState();
  const rootRef = useRef<HTMLDivElement | null>(null);

  /* SUB-091: View-as-Viewer preview. Only admins/owners can activate it
   * (server-gated; we hide the affordance for everyone else). */
  const canUseViewerMode = useCanUseViewerMode();
  const viewerModeActive = useViewerModeActive();
  const [viewerModeBusy, setViewerModeBusy] = useState(false);

  const flipViewerMode = useCallback(async (): Promise<void> => {
    if (viewerModeBusy) return;
    setViewerModeBusy(true);
    const next = !viewerModeActive;
    try {
      const ok = await toggleViewerMode(next);
      if (!ok) {
        toast.error(
          next
            ? "Couldn't enter viewer preview"
            : "Couldn't exit viewer preview",
        );
        return;
      }
      toast.success(next ? "Previewing as viewer" : "Exited viewer preview");
    } finally {
      setViewerModeBusy(false);
    }
    // Keep the menu open so the operator sees the indicator flip.
  }, [viewerModeActive, viewerModeBusy]);

  /* Register on the global dialog stack (like Modal) so Esc only
   * closes the topmost layer — opening a modal from the menu (or over
   * it) must not let one Esc press tear both surfaces down. */
  const dialogId = useId();
  const { isTop } = useDialogStack(dialogId);
  useEffect(() => {
    if (!open) return;
    pushDialog(dialogId);
    return () => popDialog(dialogId);
  }, [open, dialogId]);

  /* Load identity + version when the panel opens. Mount-time is fine
   * — we only need this when the menu is actually visible. */
  useEffect(() => {
    if (!open) {
      setServerMe(null);
      setVersion("");
      return;
    }
    let cancelled = false;
    setServerMe(null);
    setVersion("");
    void (async () => {
      const [res, v] = await Promise.all([
        apiAuth.getAuthMe(),
        tauriApi.getAppVersion(),
      ]);
      if (!cancelled && res.data) setServerMe(res.data);
      if (!cancelled && v?.version) setVersion(v.version);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useMenuInteraction({
    isTop,
    menuRef: rootRef,
    onClose,
    open,
    suspended: confirmSignOutOpen,
    trigger,
  });

  const flipTheme = useCallback((): void => {
    setTheme(theme === "dark" ? "light" : "dark");
    // Do NOT close on theme toggle — quick action, keep the menu
    // open so the operator can verify the swap then dismiss
    // intentionally.
  }, [theme]);

  const goSection = useCallback(
    (s: Parameters<typeof setSection>[0]): void => {
      setSection(s);
      onClose();
    },
    [onClose],
  );

  const goSettings = useCallback(
    (settingsAnchor: SettingsAnchor): void => {
      navigateDesktopRoute({ section: "settings", settingsAnchor });
      onClose();
    },
    [onClose],
  );

  // Fired from the ConfirmModal's confirm button. (This used to be
  // gated on window.confirm, which silently no-ops in the Tauri
  // webview — sign-out was unreachable from this menu.)
  const doSignOut = useCallback(async (): Promise<void> => {
    if (signingOut) return;
    setConfirmSignOutOpen(false);
    setSigningOut(true);
    try {
      const result = await requestFullSignOut();
      if (result !== "proceeded") return;
    } finally {
      setSigningOut(false);
    }
    toast.success("Signed out");
    onClose();
    // Brief delay so the toast paints + cookies clear before reload.
    window.setTimeout(() => window.location.reload(), 150);
  }, [signingOut, onClose]);

  const openExternal = useCallback(async (url: string): Promise<void> => {
    try {
      await tauriApi.openUrl(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open link");
    }
  }, []);

  const runUpdateAction = useCallback((): void => {
    onClose();
    if (update.phase === "not_configured") {
      navigateDesktopRoute({
        section: "settings",
        settingsAnchor: "desktop-updates",
      });
    } else if (update.phase === "ready_to_restart") {
      void requestDesktopUpdateRestart();
    } else if (update.phase === "available") {
      void installDesktopUpdate();
    } else if (update.phase === "error") {
      void retryDesktopUpdate();
    } else {
      void checkForDesktopUpdate();
    }
  }, [onClose, update.phase]);

  if (!open) return null;

  // Identity: prefer the freshly-fetched server response (has email
  // + workspace_name + totp_enabled); fall back to the store slice
  // so the menu still has SOMETHING to show during the initial
  // fetch.
  const email = serverMe?.email ?? "";
  const role = me?.role ?? serverMe?.role ?? "";
  const workspaceName = serverMe?.workspace_name?.trim() || (me?.tenant ?? "");
  const workspaceSlug = serverMe?.workspace_slug ?? "";

  return (
    <>
      <AccountMenuContent
        canUseViewerMode={canUseViewerMode}
        email={email}
        role={role}
        rootRef={rootRef}
        serverMe={serverMe}
        signingOut={signingOut}
        theme={theme}
        themePreference={themePreference}
        update={update}
        version={version}
        viewerModeActive={viewerModeActive}
        viewerModeBusy={viewerModeBusy}
        workspaceName={workspaceName}
        workspaceSlug={workspaceSlug}
        onDocumentation={() => {
          onClose();
          void openExternal("https://docs.moosewave.com");
        }}
        onFlipTheme={flipTheme}
        onFlipViewerMode={() => void flipViewerMode()}
        onOpenSignOut={() => setConfirmSignOutOpen(true)}
        onRunUpdate={runUpdateAction}
        onSection={goSection}
        onSettings={goSettings}
      />
      <ConfirmModal
        open={confirmSignOutOpen}
        title="Sign out of this device?"
        description="Your session and local API config will be cleared."
        confirmLabel="Sign out"
        danger
        busy={signingOut}
        onConfirm={() => void doSignOut()}
        onClose={() => setConfirmSignOutOpen(false)}
      />
    </>
  );
}

/* ---------- helpers + icons ---------------------------------------- */

/**
 * Compute up-to-2-char initials for the avatar. Tries the email
 * local-part first ("jane.doe@x.io" → "JD"), falls back to the
 * workspace name ("Acme Co" → "AC"), then the literal "P".
 */
export function computeInitials(email: string, workspaceName: string): string {
  const tryPick = (source: string): string => {
    const trimmed = source.trim();
    if (!trimmed) return "";
    // Treat dot/space/hyphen/underscore as word separators.
    const parts = trimmed.split(/[.\s\-_]+/).filter(Boolean);
    if (parts.length === 0) return "";
    const first = parts[0]?.[0] ?? "";
    const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : "";
    return (first + second).toUpperCase().slice(0, 2);
  };
  const local = email.split("@")[0] ?? "";
  return tryPick(local) || tryPick(workspaceName) || "P";
}

function updateMenuClass(phase: DesktopUpdatePhase): string {
  if (phase === "available") return "is-available";
  if (phase === "ready_to_restart") return "is-restart";
  if (phase === "error") return "is-error";
  return "";
}

function updateMenuLabel(
  phase: DesktopUpdatePhase,
  latestVersion: string | null,
): string {
  switch (phase) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Install Moosewave ${latestVersion ?? "update"}`;
    case "downloading":
      return `Downloading ${latestVersion ?? "update"}…`;
    case "installing":
      return `Installing ${latestVersion ?? "update"}…`;
    case "ready_to_restart":
      return "Restart to finish update";
    case "error":
      return "Update failed · Retry";
    case "up_to_date":
      return "Check for updates";
    case "not_configured":
      return "Desktop update status";
    default:
      return "Check for updates…";
  }
}

function updateMenuTail(update: DesktopUpdateState): string {
  if (
    update.phase === "downloading" &&
    update.totalBytes !== null &&
    update.totalBytes > 0
  ) {
    return `${Math.min(
      100,
      Math.round((update.downloadedBytes / update.totalBytes) * 100),
    )}%`;
  }
  if (update.phase === "available") {
    return update.severity === "informational" ? "Optional" : update.severity;
  }
  if (update.phase === "ready_to_restart") return "Ready";
  if (update.phase === "up_to_date") return "Current";
  if (update.phase === "not_configured") return "Custom build";
  return "";
}

const iconProps: SVGProps<SVGSVGElement> = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

function ThemeIcon({ dark }: { dark: boolean }): ReactElement {
  return dark ? (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ) : (
    <svg {...iconProps}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function UserIcon(): ReactElement {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

function EyeIcon(): ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function GearIcon(): ReactElement {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function KeyIcon(): ReactElement {
  return (
    <svg {...iconProps}>
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="M10 13l9-9" />
      <path d="M15 8l3 3" />
      <path d="M18 5l3 3" />
    </svg>
  );
}

function BookIcon(): ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z" />
      <path d="M4 17a3 3 0 0 1 3-3h11" />
    </svg>
  );
}

function KeyboardIcon(): ReactElement {
  return (
    <svg {...iconProps}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M19 10h.01M7 14h10" />
    </svg>
  );
}

function UpdateIcon(): ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 19h16" />
    </svg>
  );
}

function ExternalIcon(): ReactElement {
  return (
    <svg
      {...iconProps}
      width={12}
      height={12}
      className="account-menu-item-tail"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function SignOutIcon(): ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}
