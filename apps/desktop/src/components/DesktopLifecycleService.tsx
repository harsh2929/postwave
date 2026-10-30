import { type ReactElement, useEffect, useRef, useState } from "react";

import {
  cancelDesktopCloseEducation,
  chooseDesktopCloseBehavior,
  dismissInterruptedShutdownRecovery,
  recommendedDesktopCloseBehavior,
  useDesktopWindowLifecycleState,
} from "../lib/desktop-window-lifecycle";
import { routeMetaForSection } from "../lib/desktop-routes";
import { subscribeTransferHistory } from "../lib/file-transfer-history";
import {
  inspectLifecycle,
  registerLifecycleGuard,
  subscribeLifecycleGuards,
} from "../lib/lifecycle-coordinator";
import { subscribeOfflineQueue } from "../lib/offline-store";
import { isTauri, tauriApi } from "../lib/tauri";
import {
  useActiveSend,
  useCanWrite,
  useMe,
  useRoleStatus,
  useSection,
} from "../lib/store";
import { LifecycleDecisionDialog } from "./LifecycleDecisionDialog";
import { Modal, ModalFooter } from "./Modal";

/** Root UI owner for process-wide lifecycle decisions and native context. */
export function DesktopLifecycleService(): ReactElement {
  const activeSend = useActiveSend();
  const section = useSection();
  const me = useMe();
  const roleStatus = useRoleStatus();
  const canCompose = useCanWrite();
  const dirty = useLifecycleDirtyIndicator();

  useEffect(() => {
    if (!activeSend) return;
    return registerLifecycleGuard({
      id: "active-campaign-send",
      label: `Campaign sending: ${activeSend.name}`,
      kinds: [
        "close-window",
        "quit-app",
        "sign-out",
        "workspace-switch",
        "update-restart",
        "os-shutdown",
      ],
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : {
              level: "warning",
              detail:
                "The server-side send will continue, but this device will leave its live monitoring context.",
            },
    });
  }, [activeSend]);

  useEffect(() => {
    if (!isTauri()) return;
    const route = routeMetaForSection(section);
    const activeSection =
      section === "dashboard" ||
      section === "approvals" ||
      section === "settings"
        ? section
        : "other";
    void tauriApi
      .setDesktopWindowContext({
        title: `${dirty ? "● " : ""}${route.title} — Moosewave`,
        authenticated: me !== null && roleStatus === "resolved",
        canCompose,
        activeSection,
      })
      .catch(() => undefined);
  }, [canCompose, dirty, me, roleStatus, section]);

  return (
    <>
      <DesktopCloseEducationDialog />
      <InterruptedShutdownRecoveryDialog />
      <LifecycleDecisionDialog />
    </>
  );
}

function useLifecycleDirtyIndicator(): boolean {
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    const refresh = (): void => {
      const current = ++revision;
      void inspectLifecycle({
        kind: "quit-app",
        disposition: "exit",
        title: "",
        description: "",
        confirmLabel: "",
      }).then((concerns) => {
        if (!cancelled && current === revision) setDirty(concerns.length > 0);
      });
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    const disposers = [
      subscribeLifecycleGuards(refresh),
      subscribeOfflineQueue(refresh),
      subscribeTransferHistory(refresh),
    ];
    const interval = window.setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    refresh();
    return () => {
      cancelled = true;
      revision++;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const dispose of disposers) dispose();
    };
  }, []);
  return dirty;
}

export function DesktopCloseEducationDialog(): ReactElement | null {
  const lifecycle = useDesktopWindowLifecycleState();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  if (!lifecycle.closeEducationOpen) return null;
  const recommendation = recommendedDesktopCloseBehavior(lifecycle.platform);

  return (
    <Modal
      open
      role="alertdialog"
      size="sm"
      title="What should closing Moosewave do?"
      description="Choose once now; you can change this later in Desktop Settings."
      initialFocusRef={cancelRef}
      closeOnBackdrop={false}
      onClose={cancelDesktopCloseEducation}
    >
      <div className="lifecycle-close-options">
        <section>
          <h3>
            Keep running in the tray
            {recommendation === "hide" ? (
              <span className="badge success">Recommended</span>
            ) : null}
          </h3>
          <p>
            Hides the window. Sync, uploads, and server monitoring continue;
            reopen Moosewave from the tray, Dock, taskbar, or app icon.
          </p>
        </section>
        <section>
          <h3>
            Quit Moosewave
            {recommendation === "quit" ? (
              <span className="badge success">Recommended</span>
            ) : null}
          </h3>
          <p>
            Stops the desktop process after checking drafts, transfers, and
            recoverable journals. Server-side sends and imports continue.
          </p>
        </section>
      </div>
      <ModalFooter>
        <button
          ref={cancelRef}
          type="button"
          className="btn"
          onClick={cancelDesktopCloseEducation}
        >
          Cancel
        </button>
        <button
          type="button"
          className={recommendation === "quit" ? "btn btn-primary" : "btn"}
          onClick={() => void chooseDesktopCloseBehavior("quit")}
        >
          Quit Moosewave
        </button>
        <button
          type="button"
          className={recommendation === "hide" ? "btn btn-primary" : "btn"}
          onClick={() => void chooseDesktopCloseBehavior("hide")}
        >
          Keep running
        </button>
      </ModalFooter>
    </Modal>
  );
}

export function InterruptedShutdownRecoveryDialog(): ReactElement | null {
  const lifecycle = useDesktopWindowLifecycleState();
  const continueRef = useRef<HTMLButtonElement | null>(null);
  if (!lifecycle.recoveredInterruptedShutdown) return null;
  return (
    <Modal
      open
      role="alertdialog"
      size="sm"
      title="Moosewave recovered after an interrupted shutdown"
      description="The previous OS shutdown ended before Moosewave could finish its final lifecycle check."
      initialFocusRef={continueRef}
      closeOnBackdrop={false}
      onClose={dismissInterruptedShutdownRecovery}
    >
      <div className="notice notice-warning" role="status">
        Encrypted sync journals and server-side jobs were kept. Review any
        failed or conflicted items in the Sync journal and retry interrupted
        local file transfers from Transfer history.
      </div>
      <ModalFooter>
        <button
          ref={continueRef}
          type="button"
          className="btn btn-primary"
          onClick={dismissInterruptedShutdownRecovery}
        >
          Continue to Moosewave
        </button>
      </ModalFooter>
    </Modal>
  );
}
