/**
 * WorkspaceMenu — dropdown anchored beneath the sidebar workspace tile.
 *
 * Hosts the workspace name+slug header, the multi-workspace switcher
 * (profiles from lib/workspaces.ts — names + URLs in localStorage, API
 * keys in the OS keychain), theme quick-toggle, settings shortcut, and
 * sign-out. The parent (Sidebar) controls open/close — this component
 * handles outside-click + Escape itself.
 */

import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import { useMenuInteraction } from "../hooks/useMenuInteraction";
import { requestFullSignOut } from "../lib/auth";
import { navigateDesktopRoute } from "../lib/desktop-router";
import { workspaceMenuPosition } from "../lib/workspace-menu-position";
import { setTheme, useTheme, useThemePreference } from "../lib/store";
import {
  addWorkspace,
  refreshWorkspaceKeyFlags,
  removeWorkspace,
  switchWorkspace,
  useWorkspaces,
  type WorkspaceProfile,
} from "../lib/workspaces";
import { ConfirmModal } from "./ConfirmModal";
import { FormField } from "./FormField";
import { Modal, ModalFooter } from "./Modal";
import { toast } from "./Toast";

interface Props {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  workspaceName: string;
  workspaceSlug: string;
}

export function WorkspaceMenu({
  anchor,
  open,
  onClose,
  workspaceName,
  workspaceSlug,
}: Props): ReactElement | null {
  const theme = useTheme();
  const themePreference = useThemePreference();
  const ref = useRef<HTMLDivElement | null>(null);
  const signOutTimerRef = useRef<number | null>(null);
  const [confirmSignOutOpen, setConfirmSignOutOpen] = useState(false);

  /* ----- multi-workspace switcher state ----- */
  const workspaces = useWorkspaces();
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<WorkspaceProfile | null>(
    null,
  );
  /* id currently being switched to (disables the rows until reload). */
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [, setPositionRevision] = useState(0);

  /* Any hosted dialog suspends the menu's own outside-click/Escape
   * teardown (same contract the sign-out confirm uses). */
  const dialogHosted = confirmSignOutOpen || addOpen || removeTarget !== null;

  useEffect(() => {
    return () => {
      if (signOutTimerRef.current !== null) {
        window.clearTimeout(signOutTimerRef.current);
      }
    };
  }, []);

  /* Refresh the per-profile keychain flags whenever the menu opens —
   * `hasKey` is a cached projection; the keychain is the truth. */
  useEffect(() => {
    if (!open) return;
    void refreshWorkspaceKeyFlags();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let frame: number | null = null;
    const updatePosition = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setPositionRevision((value) => value + 1);
      });
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useMenuInteraction({
    menuRef: ref,
    onClose,
    open,
    selectedItemSelector: '[role="menuitemradio"][aria-checked="true"]',
    suspended: dialogHosted,
    trigger: anchor,
  });

  if (!open) return null;

  const rect = anchor?.getBoundingClientRect() ?? {
    bottom: 8,
    left: 8,
    right: 8,
    top: 8,
    width: 0,
  };
  const position = workspaceMenuPosition(
    rect,
    window.innerWidth,
    window.innerHeight,
  );

  const doSwitch = (p: WorkspaceProfile): void => {
    if (switchingId || p.id === workspaces.activeId) return;
    setSwitchingId(p.id);
    void switchWorkspace(p.id)
      .then(() => {
        // switchWorkspace reloads the app on success; this only runs in
        // environments where reload is a no-op (tests).
        setSwitchingId(null);
      })
      .catch((err: unknown) => {
        setSwitchingId(null);
        toast.error(
          err instanceof Error ? err.message : "Couldn't switch workspace.",
        );
      });
  };

  const doRemove = (p: WorkspaceProfile): void => {
    setRemoveTarget(null);
    void removeWorkspace(p.id)
      .then(() => toast.success(`Removed workspace “${p.name}”`))
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : "Couldn't remove workspace.",
        );
      });
  };

  const flipTheme = (): void => {
    setTheme(theme === "dark" ? "light" : "dark");
    onClose();
  };

  const goSettings = (): void => {
    navigateDesktopRoute({
      section: "settings",
      settingsAnchor: "workspace-profile",
    });
    onClose();
  };

  // Fired from the ConfirmModal's confirm button. (This used to be
  // gated on window.confirm, which silently no-ops in the Tauri
  // webview — sign-out was unreachable from this menu.)
  const doSignOut = async (): Promise<void> => {
    setConfirmSignOutOpen(false);
    const result = await requestFullSignOut();
    if (result !== "proceeded") return;
    toast.success("Signed out");
    onClose();
    // Slight delay so the toast paints before reload.
    if (signOutTimerRef.current !== null) {
      window.clearTimeout(signOutTimerRef.current);
    }
    signOutTimerRef.current = window.setTimeout(() => {
      signOutTimerRef.current = null;
      window.location.reload();
    }, 150);
  };

  return createPortal(
    <>
      <div
        ref={ref}
        id="workspace-menu"
        className="ws-menu"
        role="menu"
        aria-label={`Workspace menu for ${workspaceName}`}
        style={position}
      >
        <div className="ws-menu-header" aria-hidden="true">
          <div className="ws-menu-avatar">
            {(workspaceName.charAt(0) || "P").toUpperCase()}
          </div>
          <div className="ws-menu-header-text">
            <div className="ws-menu-name">{workspaceName}</div>
            <div className="ws-menu-slug">{workspaceSlug}</div>
          </div>
        </div>

        <div className="ws-menu-sep" role="separator" />

        {/* ----- multi-workspace switcher ------------------------------ */}
        <div style={sectionLabelStyle} aria-hidden="true">
          Workspaces
        </div>
        <div style={sectionHintStyle} aria-hidden="true">
          Switching reloads the app.
        </div>
        {workspaces.profiles.map((p) => {
          const active = p.id === workspaces.activeId;
          return (
            <div key={p.id} style={{ display: "flex", alignItems: "stretch" }}>
              <button
                type="button"
                className="ws-menu-item"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={active}
                disabled={switchingId !== null}
                style={{ flex: 1, minWidth: 0 }}
                onClick={() => doSwitch(p)}
              >
                <span
                  style={{ width: 14, flex: "0 0 auto" }}
                  aria-hidden="true"
                >
                  {active ? <CheckIcon /> : null}
                </span>
                <span style={{ minWidth: 0, overflow: "hidden" }}>
                  <span style={profileNameStyle}>
                    {switchingId === p.id ? `Switching to ${p.name}…` : p.name}
                  </span>
                  <span style={profileUrlStyle}>
                    {p.apiUrl}
                    {p.hasKey ? "" : " · no saved key"}
                  </span>
                </span>
              </button>
              {!active ? (
                <button
                  type="button"
                  className="ws-menu-item"
                  role="menuitem"
                  tabIndex={-1}
                  aria-label={`Remove workspace ${p.name}`}
                  disabled={switchingId !== null}
                  style={{
                    flex: "0 0 auto",
                    width: 28,
                    justifyContent: "center",
                  }}
                  onClick={() => setRemoveTarget(p)}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          className="ws-menu-item"
          role="menuitem"
          tabIndex={-1}
          onClick={() => setAddOpen(true)}
        >
          <PlusIcon />
          <span className="ws-menu-item-label">Add workspace…</span>
        </button>

        <div className="ws-menu-sep" role="separator" />

        <button
          type="button"
          className="ws-menu-item"
          role="menuitem"
          tabIndex={-1}
          onClick={flipTheme}
        >
          <ThemeIcon dark={theme === "dark"} />
          <span className="ws-menu-item-label">
            {theme === "dark"
              ? "Switch to light theme"
              : "Switch to dark theme"}
          </span>
          {themePreference === "system" ? (
            <span
              className="muted"
              style={{ marginLeft: "auto", fontSize: 11 }}
            >
              System · {theme}
            </span>
          ) : null}
        </button>

        <button
          type="button"
          className="ws-menu-item"
          role="menuitem"
          tabIndex={-1}
          onClick={goSettings}
        >
          <GearIcon />
          <span className="ws-menu-item-label">Workspace settings</span>
        </button>

        <div className="ws-menu-sep" role="separator" />

        <button
          type="button"
          className="ws-menu-item ws-menu-item-danger"
          role="menuitem"
          tabIndex={-1}
          onClick={() => setConfirmSignOutOpen(true)}
        >
          <SignOutIcon />
          <span className="ws-menu-item-label">Sign out</span>
        </button>
      </div>

      <ConfirmModal
        open={confirmSignOutOpen}
        title="Sign out of this device?"
        description="Your API URL and key will be cleared locally."
        confirmLabel="Sign out"
        danger
        onConfirm={doSignOut}
        onClose={() => setConfirmSignOutOpen(false)}
      />

      <ConfirmModal
        open={removeTarget !== null}
        title={`Remove workspace “${removeTarget?.name ?? ""}”?`}
        description="Its saved API key is deleted from this device's keychain. Nothing on the server is touched."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (removeTarget) doRemove(removeTarget);
        }}
        onClose={() => setRemoveTarget(null)}
      />

      {addOpen ? (
        <AddWorkspaceModal
          onClose={() => setAddOpen(false)}
          onAdded={(p) => {
            setAddOpen(false);
            toast.success(`Added workspace “${p.name}” — click it to switch.`);
          }}
        />
      ) : null}
    </>,
    document.body,
  );
}

/* ---------- add-workspace modal -------------------------------------- */

function AddWorkspaceModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (p: WorkspaceProfile) => void;
}): ReactElement {
  const [name, setName] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = name !== "" || apiUrl !== "" || key !== "";
  const operation = useSingleFlightOperation({
    ownerId: "add-workspace",
    label: "Add workspace operation",
    detail: "Wait for the workspace keychain request to finish.",
  });
  const discardAndClose = useCallback((): void => {
    setName("");
    setApiUrl("");
    setKey("");
    setError(null);
    setConfirmClose(false);
    onClose();
  }, [onClose]);
  useDiscardOnlyDraftLifecycle({
    ownerId: "add-workspace",
    label: "Add workspace credentials",
    dirty,
    operationRef: operation.promiseRef,
    discard: discardAndClose,
    detail:
      "Workspace connection details are not saved. Return to the dialog or explicitly discard them.",
    blocking: true,
  });

  const guardedClose = (): void => {
    if (busy || operation.active) return;
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (busy || operation.active) return;
    const request = operation.run(() => addWorkspace({ name, apiUrl, key }));
    if (!request) return;
    setError(null);
    setBusy(true);
    void request
      .then((p) => {
        setName("");
        setApiUrl("");
        setKey("");
        onAdded(p);
      })
      .catch((err: unknown) => {
        setError(lifecycleOperationError(err, "Couldn't add the workspace."));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <Modal
        open
        onClose={guardedClose}
        closeOnBackdrop={!busy && !operation.active}
        closeOnEscape={!busy && !operation.active}
        title="Add workspace"
        description="The name and URL are stored on this device; the API key goes to your OS keychain — never to localStorage."
      >
        <form onSubmit={submit}>
          <FormField label="Name" required error={error}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme production"
              autoComplete="off"
              disabled={busy || operation.active}
            />
          </FormField>
          <FormField label="API URL" required>
            <input
              type="text"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://api.acme.moosewave.com"
              autoComplete="off"
              disabled={busy || operation.active}
            />
          </FormField>
          <FormField
            label="API key"
            help="Optional — leave blank if this workspace uses email sign-in."
          >
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="pw_…"
              autoComplete="off"
              disabled={busy || operation.active}
            />
          </FormField>
          <ModalFooter>
            <button
              type="button"
              className="btn"
              onClick={guardedClose}
              disabled={busy || operation.active}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || operation.active}
            >
              {busy ? "Adding…" : "Add workspace"}
            </button>
          </ModalFooter>
        </form>
      </Modal>
      <ConfirmModal
        open={confirmClose}
        title="Discard workspace connection?"
        description="The unsaved URL and API key will be cleared from memory."
        confirmLabel="Discard connection"
        cancelLabel="Keep editing"
        danger
        onConfirm={discardAndClose}
        onClose={() => setConfirmClose(false)}
      />
    </>
  );
}

/* ---------- inline styles for the switcher section ------------------- */

const sectionLabelStyle = {
  padding: "6px 10px 0",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  opacity: 0.55,
} as const;

const sectionHintStyle = {
  padding: "0 10px 4px",
  fontSize: 11,
  opacity: 0.55,
} as const;

const profileNameStyle = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const profileUrlStyle = {
  display: "block",
  fontSize: 10,
  opacity: 0.6,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/* ---------- icons ---------------------------------------------------- */

const baseIconProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function ThemeIcon({ dark }: { dark: boolean }): ReactElement {
  return dark ? (
    // Show sun = "switch to light"
    <svg {...baseIconProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ) : (
    // Show moon = "switch to dark"
    <svg {...baseIconProps}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function GearIcon(): ReactElement {
  return (
    <svg {...baseIconProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg {...baseIconProps}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function PlusIcon(): ReactElement {
  return (
    <svg {...baseIconProps}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SignOutIcon(): ReactElement {
  return (
    <svg {...baseIconProps}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}
